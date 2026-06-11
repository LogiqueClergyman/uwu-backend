/**
 * dashboard.controller unit tests — key onboarding / listing / revocation.
 *
 * The Drizzle `db` and the logger are mocked so nothing touches Neon or stdout.
 * The chainable `db` double resolves each terminal `await` to the next value
 * pushed via `enqueue(...)` (FIFO, in the order the handler awaits them).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import { mockReq, mockRes } from './helpers/http';

const h = vi.hoisted(() => {
  const queue: any[] = [];
  const calls: Array<[string, any[]]> = [];
  const chain = (): any => {
    const c: any = {};
    for (const m of ['values', 'onConflictDoNothing', 'returning', 'set', 'where', 'limit', 'from', 'orderBy']) {
      c[m] = (...a: any[]) => { calls.push([m, a]); return chain(); };
    }
    c.then = (resolve: any, reject: any) => {
      const item = queue.length ? queue.shift() : [];
      if (item && (item as any).__throw) return Promise.reject((item as any).__throw).then(resolve, reject);
      return Promise.resolve(item).then(resolve, reject);
    };
    return c;
  };
  return {
    db: {
      insert: (...a: any[]) => { calls.push(['insert', a]); return chain(); },
      update: (...a: any[]) => { calls.push(['update', a]); return chain(); },
      select: (...a: any[]) => { calls.push(['select', a]); return chain(); },
    },
    queue,
    calls,
    enqueue: (r: any) => queue.push(r),
    enqueueThrow: (e: any) => queue.push({ __throw: e }),
    reset: () => { queue.length = 0; calls.length = 0; },
  };
});

vi.mock('../src/db', () => ({ db: h.db }));
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {}, recent: () => [], clear() {} },
}));

import { generateKeys, listKeys, revokeKey, getStats } from '../src/controllers/dashboard.controller';

const valuesOf = () => h.calls.find(([m]) => m === 'values')?.[1][0] as Record<string, any> | undefined;

beforeEach(() => h.reset());

describe('generateKeys', () => {
  it('rejects when email or platformName is missing', async () => {
    const res = mockRes();
    await generateKeys(mockReq({ body: { email: 'a@b.com' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('mints a real Ed25519 keypair and stores it (env defaults to live)', async () => {
    h.enqueue([{ env: 'live', platformName: 'Acme', createdAt: new Date('2026-01-01') }]); // .returning()
    const res = mockRes();
    await generateKeys(mockReq({ body: { email: 'a@b.com', platformName: 'Acme', setuApiKey: 'setu-xyz' } }), res);

    expect(res.statusCode).toBe(201);
    const { apiKey, clientSecretKey } = res.body;

    // The public key (api key) and secret key must be a valid Ed25519 pair.
    const pub = Buffer.from(apiKey, 'base64');
    const sec = Buffer.from(clientSecretKey, 'base64');
    expect(pub).toHaveLength(32);
    expect(sec).toHaveLength(64);
    const msg = new Uint8Array(Buffer.from('proof'));
    const sig = nacl.sign.detached(msg, new Uint8Array(sec));
    expect(nacl.sign.detached.verify(msg, sig, new Uint8Array(pub))).toBe(true);

    // Stored row carries the merchant's Setu key and the normalized env.
    const stored = valuesOf()!;
    expect(stored.setuApiKey).toBe('setu-xyz');
    expect(stored.env).toBe('live');
  });

  it('normalizes env to "test" when requested and defaults the Setu key', async () => {
    h.enqueue([{ env: 'test', platformName: 'Acme', createdAt: new Date() }]);
    const res = mockRes();
    await generateKeys(mockReq({ body: { email: 'a@b.com', platformName: 'Acme', env: 'test' } }), res);

    expect(res.statusCode).toBe(201);
    const stored = valuesOf()!;
    expect(stored.env).toBe('test');
    expect(stored.setuApiKey).toBe('setu-sandbox');
  });

  it('returns 500 when the insert fails', async () => {
    h.enqueueThrow(new Error('db down'));
    const res = mockRes();
    await generateKeys(mockReq({ body: { email: 'a@b.com', platformName: 'Acme' } }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('listKeys', () => {
  it('maps rows and never leaks the Setu/secret material', async () => {
    h.enqueue([
      { apiKey: 'pub1', platformName: 'Acme', env: 'live', revoked: false, usageCount: 3, successCount: 1, setuApiKey: 'setu-secret', createdAt: new Date() },
    ]);
    const res = mockRes();
    await listKeys(mockReq({ query: { email: 'a@b.com' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    const k = res.body.keys[0];
    expect(k.apiKey).toBe('pub1');
    expect(k.usageCount).toBe(3);
    expect('setuApiKey' in k).toBe(false);
  });

  it('returns 500 on a DB error', async () => {
    h.enqueueThrow(new Error('boom'));
    const res = mockRes();
    await listKeys(mockReq({ query: {} }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('revokeKey', () => {
  it('rejects when apiKey is missing', async () => {
    const res = mockRes();
    await revokeKey(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the key does not exist', async () => {
    h.enqueue([]); // .returning() → no row
    const res = mockRes();
    await revokeKey(mockReq({ body: { apiKey: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('soft-disables an existing key', async () => {
    h.enqueue([{ apiKey: 'pub1', revoked: true }]);
    const res = mockRes();
    await revokeKey(mockReq({ body: { apiKey: 'pub1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ apiKey: 'pub1', revoked: true });
  });
});

describe('getStats', () => {
  it('echoes the authenticated platform metrics', async () => {
    const res = mockRes();
    const req = mockReq();
    req.platformConfig = { platformName: 'Acme', usageCount: 9, successCount: 4 };
    await getStats(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      platform: 'Acme',
      metrics: { totalRequestsTracked: 9, successfulSettlements: 4 },
    });
  });
});
