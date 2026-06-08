import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { apiKeys } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface AuthenticatedRequest extends Request {
    platformConfig?: {
        apiKey: string;
        platformName: string;
        setuApiKey: string;
        usageCount: number;
        successCount: number;
    };
}

export const authenticatePlatformKey = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const apiKey = req.headers['x-uwu-api-key'] as string;
        if (!apiKey) {
            return res.status(401).json({ error: 'Unauthorized: Missing X-UwU-API-Key header' });
        }

        const [config] = await db.select().from(apiKeys).where(eq(apiKeys.apiKey, apiKey)).limit(1);

        if (!config) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }

        req.platformConfig = config;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Database authentication error' });
    }
};
