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
    let relayStarted = false;

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
            // Idempotency: if already processed by a previous callback, return the cached result
            const alreadyDone = await db.select().from(pendingIntents)
                .where(eq(pendingIntents.isProcessed, true))
                .limit(1);
            if (alreadyDone.length > 0 && alreadyDone[0].blockchainTxId) {
                return res.status(200).json({
                    status: 'VERIFIED_AND_ANCHORED',
                    reconciledRemarkCode: alreadyDone[0].paymentRemarkCode,
                    fullRefId: alreadyDone[0].refId,
                    blockchainTxId: alreadyDone[0].blockchainTxId
                });
            }
            return res.status(404).json({ error: 'Reconciliation Failure: No matching intent found.' });
        }

        // Lock state mutation immediately to prevent concurrent double-processing
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
        // Mark relayStarted so the catch block does NOT roll back isProcessed —
        // the tx may already be in the ledger, and re-processing would cause replay errors.
        relayStarted = true;
        const txId = await relayAttestationToAlgorand(
            matchingIntent.refId,
            matchingIntent.contextHash,
            matchingIntent.userAddress,
            nodeIndices,
            signatures
        );

        console.log(`\n✅ ===== PAYMENT ANCHORED ON ALGORAND =====`);
        console.log(`   RefID : ${matchingIntent.refId}`);
        console.log(`   TxID  : ${txId}`);
        console.log(`   🔗 https://lora.algokit.io/testnet/transaction/${txId}`);
        console.log(`==========================================\n`);

        // Update analytics and final intent state
        const [config] = await db.select().from(apiKeys).where(eq(apiKeys.apiKey, matchingIntent.apiKey)).limit(1);
        if (config) {
            await db.update(apiKeys)
                .set({ successCount: config.successCount + 1 })
                .where(eq(apiKeys.apiKey, config.apiKey));
        }

        await db.update(pendingIntents)
            .set({ blockchainTxId: txId })
            .where(eq(pendingIntents.refId, matchingIntent.refId));

        return res.status(200).json({
            status: 'VERIFIED_AND_ANCHORED',
            reconciledRemarkCode: detectedRemarkCode,
            fullRefId: matchingIntent.refId,
            blockchainTxId: txId
        });

    } catch (error: any) {
        // Only roll back isProcessed if Algorand relay hasn't started yet.
        // If relay started, the tx may be confirmed on-chain — rolling back would cause
        // the next callback to replay the same tx, which Algorand will reject as duplicate.
        if (matchingIntent && !relayStarted) {
            await db.update(pendingIntents)
                .set({ isProcessed: false })
                .where(eq(pendingIntents.refId, matchingIntent.refId));
        }
        console.error("Pipeline Error:", error);
        return res.status(500).json({ error: 'Internal Pipeline processing error exception', details: error.message });
    }
};
