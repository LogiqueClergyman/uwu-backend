import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { verifyClientSignature, signAttestation } from '../src/services/crypto.service';

const keyPair = nacl.sign.keyPair();
const pubKeyB64 = Buffer.from(keyPair.publicKey).toString('base64');

function signPayload(payload: object): string {
  const msg = Buffer.from(JSON.stringify(payload));
  return Buffer.from(nacl.sign.detached(new Uint8Array(msg), keyPair.secretKey)).toString('hex');
}

describe('verifyClientSignature', () => {
  const payload = {
    invoiceOrRoute: 'INV-1',
    amountPaise: 100000,
    contextHash: 'ab'.repeat(32),
    userAddress: 'WALLET',
  };

  it('accepts a valid Ed25519 signature over the JSON payload', () => {
    expect(verifyClientSignature(payload, pubKeyB64, signPayload(payload))).toBe(true);
  });

  it('rejects when the payload was tampered with', () => {
    const sig = signPayload(payload);
    const tampered = { ...payload, amountPaise: 999999 };
    expect(verifyClientSignature(tampered, pubKeyB64, sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = nacl.sign.keyPair();
    const sig = Buffer.from(
      nacl.sign.detached(new Uint8Array(Buffer.from(JSON.stringify(payload))), other.secretKey),
    ).toString('hex');
    expect(verifyClientSignature(payload, pubKeyB64, sig)).toBe(false);
  });

  it('returns false (not throws) on garbage input', () => {
    expect(verifyClientSignature(payload, pubKeyB64, 'zz-not-hex')).toBe(false);
    expect(verifyClientSignature(payload, 'not-base64!!!', signPayload(payload))).toBe(false);
  });
});

describe('signAttestation', () => {
  const refIdHex = 'a1'.repeat(32);
  const contextHashHex = 'b2'.repeat(32);
  const userAddressHex = 'c3'.repeat(32);

  it('signs refId||contextHash||userAddress, verifiable against the DVN public key', () => {
    const sig = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);

    const message = new Uint8Array(
      Buffer.concat([
        Buffer.from(refIdHex, 'hex'),
        Buffer.from(contextHashHex, 'hex'),
        Buffer.from(userAddressHex, 'hex'),
      ]),
    );
    expect(message.length).toBe(96); // contract expects exactly 32B x 3
    expect(nacl.sign.detached.verify(message, sig, keyPair.publicKey)).toBe(true);
  });

  it('signature does not verify for a different userAddress', () => {
    const sig = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);
    const wrong = new Uint8Array(
      Buffer.concat([
        Buffer.from(refIdHex, 'hex'),
        Buffer.from(contextHashHex, 'hex'),
        Buffer.from('d4'.repeat(32), 'hex'),
      ]),
    );
    expect(nacl.sign.detached.verify(wrong, sig, keyPair.publicKey)).toBe(false);
  });

  it('produces a 64-byte Ed25519 detached signature', () => {
    const sig = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it('is deterministic — identical inputs yield byte-identical signatures', () => {
    const a = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);
    const b = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it.each([
    ['refId', 'aa'.repeat(32), contextHashHex, userAddressHex],
    ['contextHash', refIdHex, 'aa'.repeat(32), userAddressHex],
    ['userAddress', refIdHex, contextHashHex, 'aa'.repeat(32)],
  ])('flipping the %s component changes the signature', (_label, r, c, u) => {
    const base = signAttestation(refIdHex, contextHashHex, userAddressHex, keyPair.secretKey);
    const mutated = signAttestation(r, c, u, keyPair.secretKey);
    expect(Buffer.from(base).equals(Buffer.from(mutated))).toBe(false);
  });

  it('a signature from DVN node A does not verify under node B\'s public key', () => {
    const nodeA = nacl.sign.keyPair();
    const nodeB = nacl.sign.keyPair();
    const sig = signAttestation(refIdHex, contextHashHex, userAddressHex, nodeA.secretKey);
    const message = new Uint8Array(
      Buffer.concat([
        Buffer.from(refIdHex, 'hex'),
        Buffer.from(contextHashHex, 'hex'),
        Buffer.from(userAddressHex, 'hex'),
      ]),
    );
    expect(nacl.sign.detached.verify(message, sig, nodeA.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(message, sig, nodeB.publicKey)).toBe(false);
  });
});

describe('verifyClientSignature — security edge cases', () => {
  const payload = { invoiceOrRoute: 'INV-9', amountPaise: 4200, contextHash: 'ab'.repeat(32), userAddress: 'WALLET' };

  it('rejects an empty signature', () => {
    expect(verifyClientSignature(payload, pubKeyB64, '')).toBe(false);
  });

  it('rejects a correctly-hex but wrong-length signature (32B, not 64B)', () => {
    expect(verifyClientSignature(payload, pubKeyB64, 'ab'.repeat(32))).toBe(false);
  });

  it('rejects a wrong-length public key (not 32B) without throwing', () => {
    const shortKey = Buffer.from(keyPair.publicKey.slice(0, 16)).toString('base64');
    expect(verifyClientSignature(payload, shortKey, signPayload(payload))).toBe(false);
  });

  it('is sensitive to JSON serialization — a re-ordered-key object is a different message', () => {
    // The SDK signs JSON.stringify(intentBlock); the server re-serializes the
    // parsed object. Insertion order must round-trip, or verification fails.
    const sig = signPayload(payload);
    const reordered = { userAddress: 'WALLET', contextHash: 'ab'.repeat(32), amountPaise: 4200, invoiceOrRoute: 'INV-9' };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(payload));
    expect(verifyClientSignature(reordered, pubKeyB64, sig)).toBe(false);
  });

  it('round-trips the exact intent block the SDK signs (cross-component contract)', () => {
    // Mirrors src/UwUCheckoutModal.tsx: sign JSON.stringify(intentBlock) with the
    // Ed25519 secret key, send signatureHex; server verifies with the public key.
    const intentBlock = {
      invoiceOrRoute: 'INV-CROSS',
      amountPaise: 250000,
      contextHash: 'cd'.repeat(32),
      userAddress: 'U5S7D23LJV4A5ET6XSRFHTU7V2EJ677ZDJNR5FPGPPV2C2ZUGUHI5EOSWA',
    };
    const messageBytes = new Uint8Array(Buffer.from(JSON.stringify(intentBlock)));
    const signatureHex = Buffer.from(nacl.sign.detached(messageBytes, keyPair.secretKey)).toString('hex');
    expect(verifyClientSignature(intentBlock, pubKeyB64, signatureHex)).toBe(true);
    // ...and the same signature must fail once a single field is tampered.
    expect(verifyClientSignature({ ...intentBlock, amountPaise: 1 }, pubKeyB64, signatureHex)).toBe(false);
  });
});
