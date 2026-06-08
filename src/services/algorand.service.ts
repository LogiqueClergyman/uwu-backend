import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import { UwUPolymorphicRegistryClient } from '../contracts/UwUPolymorphicRegistryClient';
import algosdk from 'algosdk';

let relayerClient: UwUPolymorphicRegistryClient;
let globalAppId: bigint;
let globalAlgorand: AlgorandClient;
let globalRelayerAccount: any;
let opupAppId: bigint;

export async function initAlgorandRelayer(appId: bigint) {
    globalAppId = appId;
    globalAlgorand = AlgorandClient.fromEnvironment();
    globalRelayerAccount = await globalAlgorand.account.fromEnvironment('DEPLOYER');

    relayerClient = globalAlgorand.client.getTypedAppClientById(UwUPolymorphicRegistryClient, { 
        appId, 
        defaultSender: globalRelayerAccount.addr,
        defaultSigner: globalRelayerAccount.signer
    });

    // Deploy a minimal OpUp helper app for opcode budget pooling.
    // The program is: #pragma version 11; int 1
    // Bytecode: [0x0b (version 11), 0x81 (pushint), 0x01 (value 1)]
    const opupProgram = new Uint8Array([0x0b, 0x81, 0x01]);
    console.log('[Relayer Service] Deploying OpUp helper app for opcode budget pooling...');
    const opupResult = await globalAlgorand.send.appCreate({
        sender: globalRelayerAccount.addr,
        approvalProgram: opupProgram,
        clearStateProgram: opupProgram,
        signer: globalRelayerAccount.signer,
        suppressLog: true,
    });
    opupAppId = opupResult.appId;

    console.log(`[Relayer Service] Initialized for App ID: ${appId}. OpUp App ID: ${opupAppId}`);
}

export async function relayAttestationToAlgorand(
    refIdHex: string,
    contextHashHex: string,
    userAddressBase32: string,
    nodeIndices: bigint[],
    signatures: Uint8Array[]
) {
    if (!relayerClient) throw new Error("Relayer not initialized");

    const refId = new Uint8Array(Buffer.from(refIdHex, 'hex'));
    const contextHash = new Uint8Array(Buffer.from(contextHashHex, 'hex'));
    const userAddress = algosdk.decodeAddress(userAddressBase32).publicKey;

    console.log(`[RELAYER] Submitting attestPayment for RefID: ${refIdHex}`);
    
    // Opcode budget pooling:
    // - ed25519verify_bare costs ~1900 opcode budget per call.
    // - With threshold=2, we need ~3800 budget.
    // - Each app call in a group contributes 700 to the shared pool.
    // - We add 12 calls to the opup helper (any app that succeeds) = 8400 extra budget.
    // - Total: 700 (main call) + 8400 (opup calls) = 9100.
    // - This covers 2× ed25519verify_bare (1900 each = 3800) + ARC4/box/loop overhead (~2000). ✓
    // - The main call pays for all 12 opup call fees via extraFee.
    const NUM_OPUP_CALLS = 12;

    const methodParams = await relayerClient.params.attestPayment({
        args: [refId, contextHash, userAddress, nodeIndices, signatures],
        sender: globalRelayerAccount.addr,
        extraFee: microAlgos(NUM_OPUP_CALLS * 1000), // pays for the opup calls
        boxReferences: nodeIndices.map(n => ({
            appId: globalAppId,
            name: new Uint8Array([ ...Buffer.from('dvn'), ...algosdk.encodeUint64(n) ])
        }))
    });

    const composer = globalAlgorand.send.newGroup();
    composer.addAppCallMethodCall(methodParams);

    // Add dummy OpUp calls — these go to our dedicated helper app, NOT our ABI contract.
    // Our ABI contract requires method selectors, but the opup helper accepts bare NoOp calls.
    for (let i = 0; i < NUM_OPUP_CALLS; i++) {
        composer.addAppCall({
            appId: opupAppId,
            onComplete: algosdk.OnApplicationComplete.NoOpOC,
            sender: globalRelayerAccount.addr,
            staticFee: microAlgos(0), // fee paid by the main call's extraFee above
        });
    }

    let result;
    try {
        result = await composer.send();
    } catch (err: any) {
        // algokit-utils does a post-send simulation for error diagnostics.
        // If the tx was already confirmed (duplicate callback), this simulation throws
        // "already in ledger" even though the submission itself succeeded.
        // We detect this and treat it as success by extracting the txId from the sent txns.
        const alreadyInLedger = err?.cause?.message?.includes('already in ledger') ||
                                err?.message?.includes('already in ledger');
        if (alreadyInLedger && err?.sentTransactions?.length > 0) {
            const txId = err.sentTransactions[0].txID();
            console.log(`[RELAYER] Tx already in ledger (duplicate callback). TxID: ${txId}`);
            return txId;
        }
        throw err;
    }

    const txId = result.transactions[0].txID();

    console.log(`[RELAYER] Successfully anchored to Algorand! TxID: ${txId}`);
    return txId;
}
