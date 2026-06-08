import { Request, Response } from 'express';
import { db } from '../db';
import { apiKeys, pendingIntents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { signAttestation } from '../services/crypto.service';
import { relayAttestationToAlgorand } from '../services/algorand.service';


export const setuCallback = async (req: Request, res: Response) => {
    const { mockSetuTimelineJson } = req.body;

    if (!mockSetuTimelineJson || !mockSetuTimelineJson.financialData) {
        return res.status(400).json({ error: 'Invalid Setu payload wrapper configuration structure' });
    }

    const transactions = mockSetuTimelineJson.financialData.transactions || [];
    let detectedRemarkCode = '';
    let matchingIntent: any = null;

    try {
        // [DISTRIBUTOR] Fetch all pending intents to cross-reference
        const pending = await db.select().from(pendingIntents).where(eq(pendingIntents.isProcessed, false));

        for (const tx of transactions) {
            const narration = (tx.narration || '').toUpperCase();
            
            // Look for an entry code matching our active memory intents
            for (const intent of pending) {
                if (narration.includes(intent.paymentRemarkCode)) {
                    if (intent.amountPaise === parseInt(tx.tradeValue, 10) && tx.status === 'SUCCESS') {
                        matchingIntent = intent;
                        detectedRemarkCode = intent.paymentRemarkCode;
                        break;
                    }
                }
            }
            if (matchingIntent) break;
        }

        if (!matchingIntent) {
            return res.status(404).json({ error: 'Reconciliation Failure: No matching intent found.' });
        }

        // Lock state mutation immediately
        await db.update(pendingIntents)
            .set({ isProcessed: true })
            .where(eq(pendingIntents.refId, matchingIntent.refId));

        // [VERIFIER] Execute local TEE verification simulation and generate threshold signatures
        console.log(`[VERIFIER] Simulating TEE threshold signing for RefID: ${matchingIntent.refId}`);
        const signatures: Uint8Array[] = [];
        const nodeIndices: bigint[] = [];

        if (!process.env.DVN_KEY_1 || !process.env.DVN_KEY_2) {
            throw new Error("Missing DVN_KEY_1 and DVN_KEY_2 in environment variables!");
        }

        const validatorKeys = [
            new Uint8Array(Buffer.from(process.env.DVN_KEY_1, 'base64')),
            new Uint8Array(Buffer.from(process.env.DVN_KEY_2, 'base64'))
        ];

        // Sign with the first 2 nodes to meet 2-of-N threshold
        for (let i = 0; i < 2; i++) {
            const sig = signAttestation(
                matchingIntent.refId,
                matchingIntent.contextHash,
                matchingIntent.userAddress,
                validatorKeys[i]
            );
            signatures.push(sig);
            nodeIndices.push(BigInt(i));
        }

        // [RELAYER] Dispatch on-chain
        const txId = await relayAttestationToAlgorand(
            matchingIntent.refId,
            matchingIntent.contextHash,
            matchingIntent.userAddress,
            nodeIndices,
            signatures
        );

        // Update analytics
        const [config] = await db.select().from(apiKeys).where(eq(apiKeys.apiKey, matchingIntent.apiKey)).limit(1);
        if (config) {
            await db.update(apiKeys)
                .set({ successCount: config.successCount + 1 })
                .where(eq(apiKeys.apiKey, config.apiKey));
        }

        return res.status(200).json({
            status: 'VERIFIED_AND_ANCHORED',
            reconciledRemarkCode: detectedRemarkCode,
            fullRefId: matchingIntent.refId,
            blockchainTxId: txId
        });

    } catch (error: any) {
        if (matchingIntent) {
            // Roll back state block if the processing pipeline fails
            await db.update(pendingIntents)
                .set({ isProcessed: false })
                .where(eq(pendingIntents.refId, matchingIntent.refId));
        }
        console.error("Pipeline Error:", error);
        return res.status(500).json({ error: 'Internal Pipeline processing error exception', details: error.message });
    }
};
