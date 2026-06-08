import { Request, Response } from 'express';
import nacl from 'tweetnacl';
import { db } from '../db';
import { apiKeys } from '../db/schema';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export const generateKeys = async (req: Request, res: Response) => {
    try {
        const { email, platformName, setuApiKey } = req.body;
        if (!email || !platformName || !setuApiKey) {
            return res.status(400).json({ error: 'Missing registration payload parameters' });
        }

        const keypair = nacl.sign.keyPair();
        const apiKey = Buffer.from(keypair.publicKey).toString('base64');
        const secretKey = Buffer.from(keypair.secretKey).toString('base64');

        await db.insert(apiKeys).values({
            apiKey,
            platformName,
            setuApiKey,
            usageCount: 0,
            successCount: 0
        });

        return res.status(201).json({
            message: 'Platform Onboarded',
            apiKey: apiKey,
            clientSecretKey: secretKey,
            note: 'Save the secret key inside your SDK environment securely.'
        });
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getStats = async (req: AuthenticatedRequest, res: Response) => {
    return res.status(200).json({
        platform: req.platformConfig?.platformName,
        metrics: {
            totalRequestsTracked: req.platformConfig?.usageCount,
            successfulSettlements: req.platformConfig?.successCount
        }
    });
};
