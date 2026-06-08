import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { UwUPolymorphicRegistryClient } from '../contracts/UwUPolymorphicRegistryClient';

let relayerClient: UwUPolymorphicRegistryClient;

export async function initAlgorandRelayer(appId: bigint) {
    const algorand = AlgorandClient.fromEnvironment();
    const relayerAccount = await algorand.account.fromEnvironment('DEPLOYER');

    relayerClient = algorand.client.getTypedAppClientById(UwUPolymorphicRegistryClient, { 
        appId, 
        defaultSender: relayerAccount.addr,
        defaultSigner: relayerAccount.signer
    });
    
    console.log(`[Relayer Service] Initialized for App ID: ${appId}`);
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

    console.log(`[RELAYER] Submitting attestPayment for RefID: ${refIdHex}`);
    
    // Algokit will simulate the call and populate necessary box references / fees automatically
    const result = await relayerClient.send.attestPayment({
        args: [refId, contextHash, userAddress, nodeIndices, signatures],
        populateAppCallResources: true
    });

    console.log(`[RELAYER] Confirmed TxID: ${result.txIds[0]}`);
    return result.txIds[0];
}
