import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import 'dotenv/config';

const dbUrl = process.env.DATABASE_URL || 'postgres://placeholder';
const sql = neon(dbUrl);

export const db = drizzle(sql, { schema });
