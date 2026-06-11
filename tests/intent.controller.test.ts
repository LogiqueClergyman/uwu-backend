/**
 * intent.controller unit tests — signed-intent ingestion + status lookup.
 *
 * Real Ed25519 signing (tweetnacl) exercises verifyClientSignature for real;
 * only `db` and the logger are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
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

import { createIntent, getIntentStatus } from '../src/controllers/intent.controller';

const kp = nacl.sign.keyPair();
const apiKey = Buffer.from(kp.publicKey).toString('base64');
const config = { apiKey, platformName: 'Acme', setuApiKey: 'setu-xyz', usageCount: 5, successCount: 2 };
const intentBlock = {
  invoiceOrRoute: 'INV-1',
  amountPaise: 100000,
  contextHash: 'ab'.repeat(32),
  userAddress: 'WALLET',
};
const sign = (block: object) =>
  Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(JSON.stringify(block))), kp.secretKey)).toString('hex');

function authedReq(body: any) {
  const req = mockReq({ body });
  req.platformConfig = config;
  return req;
}

beforeEach(() => h.reset());

describe('createIntent', () => {
  it('rejects a malformed body', async () => {
    const res = mockRes();
    await createIntent(authedReq({ intentBlock }), res); // no signatureHex
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid signature', async () => {
    const res = mockRes();
    await createIntent(authedReq({ intentBlock, signatureHex: 'de'.repeat(64) }), res);
    expect(res.statusCode).toBe(401);
  });

  it('stores a new intent and increments usage', async () => {
    const fullHash = crypto.createHash('sha256').update(JSON.stringify(intentBlock)).digest('hex');
    h.enqueue([{ refId: fullHash }]); // insert.returning() → inserted
    h.enqueue([]); // update api_keys usage
    const res = mockRes();
    await createIntent(authedReq({ intentBlock, signatureHex: sign(intentBlock) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ACKNOWLEDGED');
    expect(res.body.refId).toBe(fullHash);
    expect(res.body.refId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.paymentRemarkCode).toBe(fullHash.slice(0, 16).toUpperCase());
    expect(res.body.setuKey).toBe('setu-xyz');
    expect(res.body.upiIntentUri).toContain('am=1000.00');
    // usage increment happened (one update call to api_keys)
    expect(h.calls.some(([m]) => m === 'update')).toBe(true);
  });

  it('is idempotent: a duplicate intent does not re-count usage', async () => {
    h.enqueue([]); // insert.returning() → [] (onConflictDoNothing)
    const res = mockRes();
    await createIntent(authedReq({ intentBlock, signatureHex: sign(intentBlock) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ACKNOWLEDGED');
    expect(h.calls.some(([m]) => m === 'update')).toBe(false); // no usage bump
  });

  it('maps a unique-violation wrapped on err.cause.code to 409', async () => {
    h.enqueueThrow({ cause: { code: '23505' } });
    const res = mockRes();
    await createIntent(authedReq({ intentBlock, signatureHex: sign(intentBlock) }), res);
    expect(res.statusCode).toBe(409);
  });

  it('returns 500 on an unexpected DB error', async () => {
    h.enqueueThrow(new Error('db exploded'));
    const res = mockRes();
    await createIntent(authedReq({ intentBlock, signatureHex: sign(intentBlock) }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('getIntentStatus', () => {
  it('requires a refId', async () => {
    const res = mockRes();
    await getIntentStatus(mockReq({ params: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the intent is unknown', async () => {
    h.enqueue([]);
    const res = mockRes();
    await getIntentStatus(mockReq({ params: { refId: 'abc' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('reports PROCESSED with the on-chain txid', async () => {
    h.enqueue([{ isProcessed: true, blockchainTxId: 'TX123' }]);
    const res = mockRes();
    await getIntentStatus(mockReq({ params: { refId: 'abc' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'PROCESSED', blockchainTxId: 'TX123' });
  });

  it('reports PENDING when not yet anchored', async () => {
    h.enqueue([{ isProcessed: false, blockchainTxId: null }]);
    const res = mockRes();
    await getIntentStatus(mockReq({ params: { refId: 'abc' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'PENDING' });
  });
});
