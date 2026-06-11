import { Request, Response } from 'express';
import { db } from '../db';
import { apiKeys, pendingIntents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { signAttestation } from '../services/crypto.service';
import { relayAttestationToAlgorand } from '../services/algorand.service';
import { log } from '../services/logger';
import algosdk from 'algosdk';


export const setuCallback = async (req: Request, res: Response) => {
    const { mockSetuTimelineJson } = req.body;

    if (!mockSetuTimelineJson || !mockSetuTimelineJson.financialData) {
        log.warn('SETU', 'Callback rejected — invalid payload wrapper');
        return res.status(400).json({ error: 'Invalid Setu payload wrapper configuration structure' });
    }

    const transactions = mockSetuTimelineJson.financialData.transactions || [];
    let detectedRemarkCode = '';
    let matchingIntent: any = null;

    try {
        log.info('SETU', 'Bank-statement callback received', { txnCount: transactions.length });
        // [DISTRIBUTOR] Fetch all pending intents to cross-reference
        const pending = await db.select().from(pendingIntents).where(eq(pendingIntents.isProcessed, false));
        log.info('SETU', 'Cross-referencing statement against pending intents', { pending: pending.length });

        for (const tx of transactions) {
            if (!tx) continue; // Setu payloads can contain null/empty statement rows
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
            log.warn('SETU', 'Reconciliation failure — no matching intent in statement');
            return res.status(404).json({ error: 'Reconciliation Failure: No matching intent found.' });
        }
        log.success('SETU', 'Payment reconciled against intent', { remarkCode: detectedRemarkCode, refId: matchingIntent.refId });

        // Lock state mutation immediately
        log.debug('DB', 'Locking intent (isProcessed=true)', { refId: matchingIntent.refId });
        await db.update(pendingIntents)
            .set({ isProcessed: true })
            .where(eq(pendingIntents.refId, matchingIntent.refId));

        // [VERIFIER] Execute local TEE verification simulation and generate threshold signatures
        log.info('SIGN', 'TEE threshold signing (2-of-N DVN)', { refId: matchingIntent.refId });
        const signatures: Uint8Array[] = [];
        const nodeIndices: bigint[] = [];

        if (!process.env.DVN_KEY_1 || !process.env.DVN_KEY_2) {
            log.error('SIGN', 'Missing DVN_KEY_1 / DVN_KEY_2 — cannot threshold-sign');
            throw new Error("Missing DVN_KEY_1 and DVN_KEY_2 in environment variables!");
        }

        const validatorKeys = [
            new Uint8Array(Buffer.from(process.env.DVN_KEY_1, 'base64')),
            new Uint8Array(Buffer.from(process.env.DVN_KEY_2, 'base64'))
        ];

        // The intent stores userAddress as an Algorand address (base32). Both the
        // signed attestation message and the on-chain arg need the raw 32-byte
        // public key — decode it here (pass through if already 32-byte hex).
        const userAddressHex = /^[0-9a-fA-F]{64}$/.test(matchingIntent.userAddress)
            ? matchingIntent.userAddress
            : Buffer.from(algosdk.decodeAddress(matchingIntent.userAddress).publicKey).toString('hex');

        // Sign with the first 2 nodes to meet 2-of-N threshold
        for (let i = 0; i < 2; i++) {
            const sig = signAttestation(
                matchingIntent.refId,
                matchingIntent.contextHash,
                userAddressHex,
                validatorKeys[i]
            );
            signatures.push(sig);
            nodeIndices.push(BigInt(i));
        }
        log.success('SIGN', '2 threshold signatures produced', { refId: matchingIntent.refId });

        // [RELAYER] Dispatch on-chain
        log.info('CHAIN', 'Relaying attestation on-chain (attestPayment)', { refId: matchingIntent.refId });
        const txId = await relayAttestationToAlgorand(
            matchingIntent.refId,
            matchingIntent.contextHash,
            userAddressHex,
            nodeIndices,
            signatures
        );
        log.success('CHAIN', 'Attestation anchored on Algorand', { refId: matchingIntent.refId, txId });

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
        if (matchingIntent) {
            // Roll back state block if the processing pipeline fails
            await db.update(pendingIntents)
                .set({ isProcessed: false })
                .where(eq(pendingIntents.refId, matchingIntent.refId));
        }
        log.error('SETU', 'Pipeline error — rolled back intent lock', { error: error?.message || String(error), refId: matchingIntent?.refId });
        return res.status(500).json({ error: 'Internal Pipeline processing error exception', details: error.message });
    }
};
