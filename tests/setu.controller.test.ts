/**
 * setu.controller unit tests — the reconciliation + threshold-sign + anchor
 * pipeline that turns a bank statement callback into an on-chain attestation.
 *
 * `db` and the logger are mocked; the Algorand relay is stubbed to a fake txid;
 * signAttestation runs for real against ephemeral DVN keys set in the env.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import algosdk from 'algosdk';
import { mockReq, mockRes } from './helpers/http';

/** The 32-byte Ed25519 public keys behind the ephemeral DVN secret keys. */
function dvnPubKey(secretKeyB64: string): Uint8Array {
  return nacl.sign.keyPair.fromSecretKey(new Uint8Array(Buffer.from(secretKeyB64, 'base64'))).publicKey;
}

/** Rebuild the exact message the contract verifies: refId||contextHash||userAddress (96B). */
function attestationMessage(refIdHex: string, contextHashHex: string, userAddressHex: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(refIdHex, 'hex'),
      Buffer.from(contextHashHex, 'hex'),
      Buffer.from(userAddressHex, 'hex'),
    ]),
  );
}

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
    reset: () => { queue.length = 0; calls.length = 0; },
  };
});

const relayMock = vi.hoisted(() => vi.fn(async () => 'CHAIN_TX_42'));

vi.mock('../src/db', () => ({ db: h.db }));
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {}, recent: () => [], clear() {} },
}));
vi.mock('../src/services/algorand.service', () => ({
  relayAttestationToAlgorand: relayMock,
  initAlgorandRelayer: vi.fn(),
}));

import { setuCallback } from '../src/controllers/setu.controller';

const dvn1 = Buffer.from(nacl.sign.keyPair().secretKey).toString('base64');
const dvn2 = Buffer.from(nacl.sign.keyPair().secretKey).toString('base64');

const intent = {
  refId: 'a1'.repeat(32),
  apiKey: 'pub-key',
  paymentRemarkCode: 'CODE0001',
  amountPaise: 100000,
  contextHash: 'b2'.repeat(32),
  userAddress: 'c3'.repeat(32), // 64-hex → used as raw pubkey, no base32 decode
  isProcessed: false,
};

const goodCallback = {
  mockSetuTimelineJson: {
    financialData: {
      transactions: [
        { narration: 'UPI/P2M/CODE0001/settlement', tradeValue: '100000', status: 'SUCCESS' },
      ],
    },
  },
};

beforeEach(() => {
  h.reset();
  relayMock.mockClear();
  process.env.DVN_KEY_1 = dvn1;
  process.env.DVN_KEY_2 = dvn2;
});

afterEach(() => {
  delete process.env.DVN_KEY_1;
  delete process.env.DVN_KEY_2;
});

describe('setuCallback validation', () => {
  it('rejects a missing payload wrapper', async () => {
    const res = mockRes();
    await setuCallback(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a payload without financialData', async () => {
    const res = mockRes();
    await setuCallback(mockReq({ body: { mockSetuTimelineJson: {} } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('reconciliation', () => {
  it('returns 404 when no pending intent matches the narration', async () => {
    h.enqueue([intent]); // select pending
    const res = mockRes();
    await setuCallback(mockReq({
      body: { mockSetuTimelineJson: { financialData: { transactions: [{ narration: 'UPI/UNKNOWN', tradeValue: '100000', status: 'SUCCESS' }] } } },
    }), res);
    expect(res.statusCode).toBe(404);
    expect(relayMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the code matches but the amount does not', async () => {
    h.enqueue([intent]);
    const res = mockRes();
    await setuCallback(mockReq({
      body: { mockSetuTimelineJson: { financialData: { transactions: [{ narration: 'UPI/CODE0001', tradeValue: '999', status: 'SUCCESS' }] } } },
    }), res);
    expect(res.statusCode).toBe(404);
  });

  it('skips null statement rows without crashing', async () => {
    h.enqueue([intent]);
    const res = mockRes();
    await setuCallback(mockReq({
      body: { mockSetuTimelineJson: { financialData: { transactions: [null, { narration: 'UPI/UNKNOWN', tradeValue: '1', status: 'SUCCESS' }] } } },
    }), res);
    expect(res.statusCode).toBe(404); // no match, but no throw either
  });
});

describe('happy path', () => {
  it('reconciles, threshold-signs (2-of-N), anchors, and returns the txid', async () => {
    h.enqueue([intent]);                          // 1. select pending
    h.enqueue([]);                                // 2. update lock isProcessed=true
    h.enqueue([{ apiKey: 'pub-key', successCount: 0 }]); // 3. select api_keys
    h.enqueue([]);                                // 4. update successCount
    h.enqueue([]);                                // 5. update blockchainTxId

    const res = mockRes();
    await setuCallback(mockReq({ body: goodCallback }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'VERIFIED_AND_ANCHORED',
      reconciledRemarkCode: 'CODE0001',
      fullRefId: intent.refId,
      blockchainTxId: 'CHAIN_TX_42',
    });

    expect(relayMock).toHaveBeenCalledTimes(1);
    const [refId, contextHash, userAddressHex, nodeIndices, signatures] = relayMock.mock.calls[0] as any[];
    expect(refId).toBe(intent.refId);
    expect(contextHash).toBe(intent.contextHash);
    expect(userAddressHex).toBe(intent.userAddress);
    expect(nodeIndices).toEqual([0n, 1n]); // 2-of-N threshold, node indices 0 and 1
    expect(signatures).toHaveLength(2);

    // The relayed signatures must be REAL Ed25519 attestations over
    // refId||contextHash||userAddress — verifiable against the two DVN pubkeys.
    const message = attestationMessage(refId, contextHash, userAddressHex);
    expect(nacl.sign.detached.verify(message, signatures[0], dvnPubKey(dvn1))).toBe(true);
    expect(nacl.sign.detached.verify(message, signatures[1], dvnPubKey(dvn2))).toBe(true);
    // node 0's signature must NOT verify under node 1's key (distinct signers).
    expect(nacl.sign.detached.verify(message, signatures[0], dvnPubKey(dvn2))).toBe(false);
  });

  it('decodes a base32 Algorand address to the raw 32-byte pubkey before signing', async () => {
    const account = algosdk.generateAccount();
    const addr = account.addr.toString(); // algosdk v3 addr is an Address object; the DB stores the string
    const expectedHex = Buffer.from(algosdk.decodeAddress(addr).publicKey).toString('hex');
    const base32Intent = { ...intent, userAddress: addr };

    h.enqueue([base32Intent]);                    // 1. select pending
    h.enqueue([]);                                // 2. lock
    h.enqueue([{ apiKey: 'pub-key', successCount: 0 }]); // 3. select api_keys
    h.enqueue([]);                                // 4. successCount
    h.enqueue([]);                                // 5. blockchainTxId

    const res = mockRes();
    await setuCallback(mockReq({ body: goodCallback }), res);

    expect(res.statusCode).toBe(200);
    const [refId, contextHash, userAddressHex, , signatures] = relayMock.mock.calls[0] as any[];
    expect(userAddressHex).toBe(expectedHex); // base32 → 64-hex pubkey
    // signatures cover the DECODED address, not the raw base32 string
    const message = attestationMessage(refId, contextHash, userAddressHex);
    expect(nacl.sign.detached.verify(message, signatures[0], dvnPubKey(dvn1))).toBe(true);
  });
});

describe('failure handling', () => {
  it('rolls the intent lock back and returns 500 when DVN keys are absent', async () => {
    delete process.env.DVN_KEY_1;
    h.enqueue([intent]); // select pending
    h.enqueue([]);       // update lock
    h.enqueue([]);       // rollback update
    const res = mockRes();
    await setuCallback(mockReq({ body: goodCallback }), res);

    expect(res.statusCode).toBe(500);
    expect(relayMock).not.toHaveBeenCalled();
    // the rollback set isProcessed back to false
    const rollback = h.calls.find(([m, a]) => m === 'set' && a[0]?.isProcessed === false);
    expect(rollback).toBeTruthy();
  });
});
