import { Response } from 'express';
import * as crypto from 'crypto';
import { db } from '../db';
import { apiKeys, pendingIntents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { verifyClientSignature } from '../services/crypto.service';

export const createIntent = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const config = req.platformConfig!;
        const { intentBlock, signatureHex } = req.body;

        if (!intentBlock || !signatureHex) {
            return res.status(400).json({ error: 'Malformed request body structure' });
        }

        const isSignatureValid = verifyClientSignature(intentBlock, config.apiKey, signatureHex);
        if (!isSignatureValid) {
            return res.status(401).json({ error: 'Security Panic: Invalid cryptographic request signature' });
        }

        const fullHash = crypto.createHash('sha256').update(JSON.stringify(intentBlock)).digest('hex');
        const shortRefId = fullHash.substring(0, 16).toUpperCase();

        const defaultHash = Buffer.alloc(32, 0).toString('hex');
        const defaultAddr = Buffer.alloc(32, 0).toString('hex');

        await db.insert(pendingIntents).values({
            refId: fullHash,
            apiKey: config.apiKey,
            paymentRemarkCode: shortRefId,
            invoiceOrRoute: intentBlock.invoiceOrRoute,
            amountPaise: intentBlock.amountPaise,
            contextHash: intentBlock.contextHash || defaultHash,
            userAddress: intentBlock.userAddress || defaultAddr,
            isProcessed: false
        });

        await db.update(apiKeys)
            .set({ usageCount: config.usageCount + 1 })
            .where(eq(apiKeys.apiKey, config.apiKey));

        return res.status(200).json({
            status: 'ACKNOWLEDGED',
            refId: fullHash,
            paymentRemarkCode: shortRefId,
            upiIntentUri: `upi://pay?pa=uwu@bank&am=${(intentBlock.amountPaise / 100).toFixed(2)}&tn=${shortRefId}`
        });
    } catch (err: any) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Intent already exists' });
        }
        console.error(err);
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
            return res.status(200).json({
                status: 'PROCESSED',
                blockchainTxId: intent.blockchainTxId
            });
        }

        return res.status(200).json({ status: 'PENDING' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
