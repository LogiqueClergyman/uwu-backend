/**
 * LIVE end-to-end attestation test.
 *
 * Exercises the full pipeline against a RUNNING backend and the real Algorand
 * testnet (it submits an on-chain transaction and spends a small fee), so it is
 * opt-in. Skipped unless explicitly enabled:
 *
 *   UWU_E2E=1 \
 *   UWU_TEST_API_KEY=<merchant api key (base64 Ed25519 public key)> \
 *   UWU_TEST_SECRET_KEY=<merchant base64 Ed25519 secret key> \
 *   npm test
 *
 * Optional: UWU_API_URL (default http://localhost:4000).
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import nacl from 'tweetnacl';

const BASE = process.env.UWU_API_URL || 'http://localhost:4000';
const API_KEY = process.env.UWU_TEST_API_KEY || '';
const SECRET_KEY = process.env.UWU_TEST_SECRET_KEY || '';
const ENABLED = process.env.UWU_E2E === '1' && !!API_KEY && !!SECRET_KEY;

async function json(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await resp.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return { status: resp.status, body: parsed, text };
}

describe.skipIf(!ENABLED)('live E2E: intent → callback → on-chain attestation', () => {
  it('anchors a payment proof on Algorand and reports PROCESSED', async () => {
    // 1) signed intent
    const invoiceOrRoute = `E2E-${Date.now()}`;
    const intentBlock = {
      invoiceOrRoute,
      amountPaise: 100000,
      contextHash: crypto.createHash('sha256').update(invoiceOrRoute).digest('hex'),
      userAddress: 'U5S7D23LJV4A5ET6XSRFHTU7V2EJ677ZDJNR5FPGPPV2C2ZUGUHI5EOSWA',
    };
    const signatureHex = Buffer.from(
      nacl.sign.detached(
        new Uint8Array(Buffer.from(JSON.stringify(intentBlock))),
        new Uint8Array(Buffer.from(SECRET_KEY, 'base64')),
      ),
    ).toString('hex');

    const intent = await json('POST', '/api/v1/intent/create', { 'X-UwU-API-Key': API_KEY }, { intentBlock, signatureHex });
    expect(intent.status).toBe(200);
    expect(intent.body.refId).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.body.paymentRemarkCode).toHaveLength(16);
    // the setuKey contract: intent response must carry the merchant's Setu key
    expect(intent.body.setuKey).toBeTruthy();

    // 2) mock Setu callback with a matching transaction narration
    const callback = await json('POST', '/api/v1/mock/setu/callback', {}, {
      mockSetuTimelineJson: {
        financialData: {
          transactions: [{
            amount: 100000,
            tradeValue: '100000',
            status: 'SUCCESS',
            date: new Date().toISOString(),
            utr: `E2E${Date.now()}`,
            narration: `UPI/P2M/${intent.body.paymentRemarkCode}/E2E`,
            bankAccount: 'Test Bank XXXX 0000',
          }],
        },
      },
    });
    expect(callback.status, callback.text).toBe(200);
    expect(callback.body.status).toBe('VERIFIED_AND_ANCHORED');
    expect(callback.body.blockchainTxId).toBeTruthy();

    // 3) status reflects the anchored transaction
    const status = await json('GET', `/api/v1/intent/status/${intent.body.refId}`, { 'X-UwU-API-Key': API_KEY });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: 'PROCESSED', blockchainTxId: callback.body.blockchainTxId });
  });
});

// Always-on guard so the suite never silently reports "0 tests" here.
describe('live E2E gate', () => {
  it(ENABLED ? 'is enabled' : 'is skipped (set UWU_E2E=1 + UWU_TEST_API_KEY/SECRET_KEY to run)', () => {
    expect(true).toBe(true);
  });
});
