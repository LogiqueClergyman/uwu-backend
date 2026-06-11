import { Request, Response } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import * as crypto from 'crypto';
import { log } from '../services/logger';

export const signup = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email parameter required' });
        log.info('AUTH', 'Signup requested', { email });

        const newUser = await db.insert(users).values({
            id: crypto.randomUUID(),
            email
        }).returning();

        log.success('AUTH', 'User created', { email, id: newUser[0].id });
        return res.status(201).json({ message: 'Signup successful', user: newUser[0] });
    } catch (err: any) {
        if (err.code === '23505') { // Postgres unique violation
            log.warn('AUTH', 'Signup conflict — user already exists', { email: req.body?.email });
            return res.status(409).json({ error: 'User already exists' });
        }
        log.error('AUTH', 'Signup failed', { error: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: 'Internal server error' });
    }
};
