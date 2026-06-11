import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { UwUPolymorphicRegistryClient } from '../contracts/UwUPolymorphicRegistryClient';
import { log } from './logger';

let relayerClient: UwUPolymorphicRegistryClient;

export async function initAlgorandRelayer(appId: bigint) {
    const algorand = AlgorandClient.fromEnvironment();
    const relayerAccount = await algorand.account.fromEnvironment('DEPLOYER');

    relayerClient = algorand.client.getTypedAppClientById(UwUPolymorphicRegistryClient, { 
        appId, 
        defaultSender: relayerAccount.addr,
        defaultSigner: relayerAccount.signer
    });
    
    log.success('CHAIN', 'Algorand relayer initialized', { appId: appId.toString() });
}

export async function relayAttestationToAlgorand(
    refIdHex: string,
    contextHashHex: string,
    userAddressHex: string,
    nodeIndices: bigint[],
    signatures: Uint8Array[]
) {
    if (!relayerClient) throw new Error("Relayer not initialized");

    const refId = new Uint8Array(Buffer.from(refIdHex, 'hex'));
    const contextHash = new Uint8Array(Buffer.from(contextHashHex, 'hex'));
    const userAddress = new Uint8Array(Buffer.from(userAddressHex, 'hex'));

    log.info('CHAIN', 'Submitting attestPayment group', { refId: refIdHex });

    // attestPayment runs 2x ed25519verify_bare (~1900 opcodes each) for the 2-of-N
    // DVN threshold — far over the 700-opcode/txn budget. Pool extra budget by
    // padding the group with cheap getPayment no-ops (each app call adds 700 to the
    // shared pool). getPayment reads the box that attestPayment creates earlier in
    // the same group, so the pads must come AFTER attestPayment.
    const PAD_CALLS = 7; // (1 + 7) * 700 = 5600 budget, covers ~3800 for 2x verify
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let group: any = relayerClient.newGroup().attestPayment({
        args: [refId, contextHash, userAddress, nodeIndices, signatures],
        note: new Uint8Array(Buffer.from(`uwu-attest:${refIdHex}`)),
    });
    // Each pad needs a unique note, otherwise the identical getPayment calls share a
    // txid and the network rejects the group ("transaction already in ledger").
    for (let i = 0; i < PAD_CALLS; i++) {
        group = group.getPayment({
            args: [refId],
            note: new Uint8Array(Buffer.from(`uwu-pad:${refIdHex}:${i}`)),
        });
    }

    // Algokit simulates to populate box references / fees automatically.
    const result = await group.send({ populateAppCallResources: true });

    log.success('CHAIN', 'attestPayment group confirmed', { txId: result.txIds[0] });
    return result.txIds[0];
}
