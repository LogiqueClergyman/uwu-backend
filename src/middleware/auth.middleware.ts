import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { apiKeys } from '../db/schema';
import { eq } from 'drizzle-orm';
import { log } from '../services/logger';

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
            log.warn('AUTH', 'Request missing X-UwU-API-Key header');
            return res.status(401).json({ error: 'Unauthorized: Missing X-UwU-API-Key header' });
        }

        const [config] = await db.select().from(apiKeys).where(eq(apiKeys.apiKey, apiKey)).limit(1);

        if (!config) {
            log.warn('AUTH', 'Invalid API key — rejecting', { apiKey });
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }

        log.debug('AUTH', 'API key authenticated', { platform: config.platformName, apiKey });
        req.platformConfig = config;
        next();
    } catch (err) {
        log.error('AUTH', 'Auth DB error', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: 'Database authentication error' });
    }
};
