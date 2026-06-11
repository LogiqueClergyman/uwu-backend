import { Response } from 'express';
import * as crypto from 'crypto';
import { db } from '../db';
import { apiKeys, pendingIntents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { verifyClientSignature } from '../services/crypto.service';
import { log } from '../services/logger';

export const createIntent = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const config = req.platformConfig!;
        const { intentBlock, signatureHex } = req.body;

        if (!intentBlock || !signatureHex) {
            log.warn('INTENT', 'Intent rejected — malformed body', { platform: config.platformName });
            return res.status(400).json({ error: 'Malformed request body structure' });
        }
        log.info('INTENT', 'Intent received', { platform: config.platformName, apiKey: config.apiKey, amountPaise: intentBlock.amountPaise });

        log.info('SIGN', 'Verifying client Ed25519 signature over intent', { apiKey: config.apiKey });
        const isSignatureValid = verifyClientSignature(intentBlock, config.apiKey, signatureHex);
        if (!isSignatureValid) {
            log.error('SIGN', 'Invalid client signature — rejecting intent', { apiKey: config.apiKey });
            return res.status(401).json({ error: 'Security Panic: Invalid cryptographic request signature' });
        }
        log.success('SIGN', 'Client signature verified');

        const fullHash = crypto.createHash('sha256').update(JSON.stringify(intentBlock)).digest('hex');
        const shortRefId = fullHash.substring(0, 16).toUpperCase();
        log.debug('INTENT', 'Computed refId', { refId: fullHash, remarkCode: shortRefId });

        const defaultHash = Buffer.alloc(32, 0).toString('hex');
        const defaultAddr = Buffer.alloc(32, 0).toString('hex');

        // Idempotent: refId is a deterministic hash of the intent, so re-submitting the
        // same intent (e.g. re-running the demo) must NOT 500 on a primary-key collision.
        log.debug('DB', 'Inserting pending_intent (idempotent)', { refId: fullHash });
        const inserted = await db.insert(pendingIntents).values({
            refId: fullHash,
            apiKey: config.apiKey,
            paymentRemarkCode: shortRefId,
            invoiceOrRoute: intentBlock.invoiceOrRoute,
            amountPaise: intentBlock.amountPaise,
            contextHash: intentBlock.contextHash || defaultHash,
            userAddress: intentBlock.userAddress || defaultAddr,
            isProcessed: false
        }).onConflictDoNothing().returning({ refId: pendingIntents.refId });

        // Only count usage when a genuinely new intent was created.
        if (inserted.length > 0) {
            await db.update(apiKeys)
                .set({ usageCount: config.usageCount + 1 })
                .where(eq(apiKeys.apiKey, config.apiKey));
            log.success('INTENT', 'Intent stored & acknowledged', { refId: fullHash, remarkCode: shortRefId });
        } else {
            log.info('INTENT', 'Intent already exists (idempotent no-op)', { refId: fullHash });
        }

        return res.status(200).json({
            status: 'ACKNOWLEDGED',
            refId: fullHash,
            paymentRemarkCode: shortRefId,
            upiIntentUri: `upi://pay?pa=uwu@bank&am=${(intentBlock.amountPaise / 100).toFixed(2)}&tn=${shortRefId}`,
            // The merchant's own Setu key, stored against their API key at onboarding.
            // The SDK uses this to make Setu calls directly from the frontend.
            setuKey: config.setuApiKey
        });
    } catch (err: any) {
        // DrizzleQueryError wraps the pg error — the SQLSTATE lives on err.cause.code.
        if (err?.code === '23505' || err?.cause?.code === '23505') {
            log.info('INTENT', 'Intent already exists (duplicate refId)');
            return res.status(409).json({ error: 'Intent already exists' });
        }
        log.error('INTENT', 'Intent creation failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getIntentStatus = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { refId } = req.params;
        if (!refId) return res.status(400).json({ error: 'refId required' });

        const [intent] = await db.select().from(pendingIntents).where(eq(pendingIntents.refId, refId)).limit(1);

        if (!intent) {
            return res.status(404).json({ error: 'Intent not found' });
        }

        if (intent.isProcessed && intent.blockchainTxId) {
            log.debug('INTENT', 'Status query → PROCESSED', { refId, blockchainTxId: intent.blockchainTxId });
            return res.status(200).json({
                status: 'PROCESSED',
                blockchainTxId: intent.blockchainTxId
            });
        }

        log.debug('INTENT', 'Status query → PENDING', { refId });
        return res.status(200).json({ status: 'PENDING' });
    } catch (err) {
        log.error('INTENT', 'Status query failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: 'Internal server error' });
    }
};
