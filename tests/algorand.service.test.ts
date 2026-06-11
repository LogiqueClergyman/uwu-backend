/**
 * algorand.service unit tests — the on-chain relay that anchors the DVN
 * threshold signatures via attestPayment.
 *
 * algokit-utils + the generated typed client are mocked, so no network/testnet
 * is touched. We assert the *group construction* contract: one attestPayment
 * call carrying the 5 contract args, padded with 7 uniquely-noted getPayment
 * no-ops to pool enough opcode budget for 2x ed25519verify_bare.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  const groupCalls: Array<[string, any]> = [];
  const sendMock = vi.fn(async () => ({ txIds: ['ALGO_TX_1'] }));
  const makeGroup = (): any => {
    const g: any = {
      attestPayment: (arg: any) => { groupCalls.push(['attestPayment', arg]); return g; },
      getPayment: (arg: any) => { groupCalls.push(['getPayment', arg]); return g; },
      send: sendMock,
    };
    return g;
  };
  const getTypedAppClientById = vi.fn(() => ({ newGroup: () => makeGroup() }));
  const fromEnvironment = vi.fn(() => ({
    account: { fromEnvironment: vi.fn(async () => ({ addr: 'RELAYER_ADDR', signer: 'SIGNER' })) },
    client: { getTypedAppClientById },
  }));
  return { groupCalls, sendMock, getTypedAppClientById, fromEnvironment };
});

vi.mock('@algorandfoundation/algokit-utils', () => ({
  AlgorandClient: { fromEnvironment: H.fromEnvironment },
}));
vi.mock('../src/contracts/UwUPolymorphicRegistryClient', () => ({
  UwUPolymorphicRegistryClient: class {},
}));
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {} },
}));

async function freshService() {
  vi.resetModules();
  return import('../src/services/algorand.service');
}

const refIdHex = 'a1'.repeat(32);
const contextHashHex = 'b2'.repeat(32);
const userAddressHex = 'c3'.repeat(32);
const signatures = [new Uint8Array(64), new Uint8Array(64)];
const nodeIndices = [0n, 1n];

beforeEach(() => {
  H.groupCalls.length = 0;
  H.sendMock.mockClear();
});

describe('relayAttestationToAlgorand', () => {
  it('throws when the relayer was never initialized', async () => {
    const svc = await freshService();
    await expect(
      svc.relayAttestationToAlgorand(refIdHex, contextHashHex, userAddressHex, nodeIndices, signatures),
    ).rejects.toThrow(/Relayer not initialized/);
  });

  it('builds an attestPayment group padded with 7 uniquely-noted getPayment no-ops', async () => {
    const svc = await freshService();
    await svc.initAlgorandRelayer(764120075n);

    const txId = await svc.relayAttestationToAlgorand(
      refIdHex, contextHashHex, userAddressHex, nodeIndices, signatures,
    );

    expect(txId).toBe('ALGO_TX_1');
    // algokit must simulate to populate box refs + fees
    expect(H.sendMock).toHaveBeenCalledWith({ populateAppCallResources: true });

    const attest = H.groupCalls.filter(([m]) => m === 'attestPayment');
    const pads = H.groupCalls.filter(([m]) => m === 'getPayment');
    expect(attest).toHaveLength(1);
    expect(pads).toHaveLength(7); // (1 + 7) * 700 = 5600 budget for 2x ~1900-opcode verify

    // attestPayment carries exactly the 5 contract args + a stable note
    const [, attestArg] = attest[0];
    expect(attestArg.args).toHaveLength(5);
    expect(attestArg.args[3]).toBe(nodeIndices);
    expect(attestArg.args[4]).toBe(signatures);
    expect(Buffer.from(attestArg.note).toString()).toBe(`uwu-attest:${refIdHex}`);

    // the decoded 32-byte args must match the hex inputs
    expect(Buffer.from(attestArg.args[0]).toString('hex')).toBe(refIdHex);
    expect(Buffer.from(attestArg.args[1]).toString('hex')).toBe(contextHashHex);
    expect(Buffer.from(attestArg.args[2]).toString('hex')).toBe(userAddressHex);

    // every pad note must be unique, else identical getPayment txids collide
    const padNotes = pads.map(([, a]) => Buffer.from(a.note).toString());
    expect(new Set(padNotes).size).toBe(7);
    expect(padNotes).toContain(`uwu-pad:${refIdHex}:0`);
    expect(padNotes).toContain(`uwu-pad:${refIdHex}:6`);
  });
});
