import nacl from 'tweetnacl';
import { log } from './logger';

/**
 * Verifies the Client SDK's Ed25519 signature over an Intent payload.
 */
export function verifyClientSignature(
    payload: object,
    publicKeyBase64: string,
    signatureHex: string
): boolean {
    try {
        const messageBytes = Buffer.from(JSON.stringify(payload));
        const signatureBytes = Buffer.from(signatureHex, 'hex');
        const pubKeyBytes = Buffer.from(publicKeyBase64, 'base64');

        return nacl.sign.detached.verify(messageBytes, signatureBytes, pubKeyBytes);
    } catch (err) {
        return false;
    }
}

/**
 * Simulates a Verifier Node (DVN) signing an attestation fact.
 * The message MUST exactly match the AVM concatenation in the smart contract:
 * refId (32B) || contextHash (32B) || userAddress (32B)
 */
export function signAttestation(
    refIdHex: string,
    contextHashHex: string,
    userAddressHex: string,
    privateKeyUint8Array: Uint8Array
): Uint8Array {
    const message = Buffer.concat([
        Buffer.from(refIdHex, 'hex'),
        Buffer.from(contextHashHex, 'hex'),
        Buffer.from(userAddressHex, 'hex')
    ]);
    log.debug('SIGN', 'Signing attestation (refId||contextHash||userAddress)', { refId: refIdHex });

    return nacl.sign.detached(new Uint8Array(message), privateKeyUint8Array);
}
