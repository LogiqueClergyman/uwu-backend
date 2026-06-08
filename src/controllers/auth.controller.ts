import { Request, Response } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import * as crypto from 'crypto';

export const signup = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email parameter required' });

        const newUser = await db.insert(users).values({
            id: crypto.randomUUID(),
            email
        }).returning();

        return res.status(201).json({ message: 'Signup successful', user: newUser[0] });
    } catch (err: any) {
        if (err.code === '23505') { // Postgres unique violation
            return res.status(409).json({ error: 'User already exists' });
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
};
