import { Request, Response } from 'express';
import nacl from 'tweetnacl';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { apiKeys } from '../db/schema';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { log } from '../services/logger';

// Neon serverless suspends idle compute; the first query after it wakes can throw
// "fetch failed". Retry transient connection errors so cold-starts don't surface as 500s.
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /fetch failed|ECONNRESET|ETIMEDOUT|Connection terminated|socket hang up/i.test(msg);
            if (transient && i < tries - 1) {
                await new Promise((r) => setTimeout(r, 400 * (i + 1)));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

export const generateKeys = async (req: Request, res: Response) => {
    try {
        const { email, platformName, setuApiKey, env } = req.body;
        if (!email || !platformName) {
            log.warn('KEYS', 'Key generation rejected — missing email/platformName');
            return res.status(400).json({ error: 'Missing registration payload parameters' });
        }
        log.info('KEYS', 'Key generation requested', { email, platformName, env: env === 'test' ? 'test' : 'live' });

        const keypair = nacl.sign.keyPair();
        const apiKey = Buffer.from(keypair.publicKey).toString('base64');
        const secretKey = Buffer.from(keypair.secretKey).toString('base64');
        log.info('SIGN', 'Generated Ed25519 keypair (public key = API key)', { apiKey });

        log.debug('DB', 'Inserting api_keys row', { apiKey, ownerEmail: email });
        const [row] = await withRetry(() => db.insert(apiKeys).values({
            apiKey,
            platformName,
            setuApiKey: setuApiKey || 'setu-sandbox',
            ownerEmail: email,
            env: env === 'test' ? 'test' : 'live',
            usageCount: 0,
            successCount: 0
        }).returning());
        log.success('KEYS', 'API key created & stored', { apiKey, env: row.env, ownerEmail: email });

        return res.status(201).json({
            message: 'Platform Onboarded',
            apiKey,
            clientSecretKey: secretKey,
            env: row.env,
            platformName: row.platformName,
            createdAt: row.createdAt,
            note: 'Save the secret key inside your SDK environment securely. It is shown only once.'
        });
    } catch (err) {
        log.error('KEYS', 'Key generation failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    }
};

// List a dashboard user's keys (never returns the secret — it isn't stored).
export const listKeys = async (req: Request, res: Response) => {
    try {
        const email = (req.query.email as string) || '';
        const rows = await withRetry(() => email
            ? db.select().from(apiKeys).where(eq(apiKeys.ownerEmail, email)).orderBy(desc(apiKeys.createdAt))
            : db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)));

        const keys = rows.map((k) => ({
            apiKey: k.apiKey,
            platformName: k.platformName,
            env: k.env,
            revoked: k.revoked,
            usageCount: k.usageCount,
            successCount: k.successCount,
            createdAt: k.createdAt,
        }));
        log.info('KEYS', 'Listed keys', { email: email || 'all', count: keys.length });
        return res.status(200).json({ keys });
    } catch (err) {
        log.error('KEYS', 'List keys failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    }
};

// Revoke a key (soft-disable).
export const revokeKey = async (req: Request, res: Response) => {
    try {
        const { apiKey } = req.body;
        if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
        log.info('KEYS', 'Revoke requested', { apiKey });
        const [row] = await withRetry(() => db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.apiKey, apiKey)).returning());
        if (!row) {
            log.warn('KEYS', 'Revoke: key not found', { apiKey });
            return res.status(404).json({ error: 'Key not found' });
        }
        log.success('KEYS', 'Key revoked', { apiKey });
        return res.status(200).json({ apiKey: row.apiKey, revoked: row.revoked });
    } catch (err) {
        log.error('KEYS', 'Revoke failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
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
