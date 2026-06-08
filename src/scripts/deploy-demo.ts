import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { UwUPolymorphicRegistryFactory } from '../contracts/UwUPolymorphicRegistryClient';
import nacl from 'tweetnacl';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

async function deploy() {
    console.log("=== Deploying UwU Contract ===");
    const algorand = AlgorandClient.fromEnvironment();
    const deployer = await algorand.account.fromEnvironment('DEPLOYER');

    const pubKeys: Uint8Array[] = [];
    const secretKeys: string[] = [];
    
    for (let i = 0; i < 3; i++) {
        const kp = nacl.sign.keyPair();
        pubKeys.push(kp.publicKey);
        secretKeys.push(Buffer.from(kp.secretKey).toString('base64'));
    }

    console.log("Deploying UwUPolymorphicRegistry...");
    const factory = algorand.client.getTypedAppFactory(UwUPolymorphicRegistryFactory, {
        defaultSender: deployer.addr,
    });
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' });
    const appId = Number(appClient.appId);
    console.log(`Deployed! App ID: ${appId}`);

    console.log("Funding contract for box storage...");
    await algorand.send.payment({
        amount: (1).algo(),
        sender: deployer.addr,
        receiver: appClient.appAddress,
    });

    console.log("Registering Validator Nodes (DVN) on-chain...");
    await appClient.send.updateDvnConfig({
        args: [2n, pubKeys],
        populateAppCallResources: true
    });
    console.log("DVN registered successfully.");

    const envPath = path.join(__dirname, '../../.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Strip old variables
    const keysToRemove = ['APP_ID=', 'DVN_KEY_1=', 'DVN_KEY_2=', 'DVN_KEY_3='];
    const filteredLines = envContent.split('\n').filter(line => {
        return !keysToRemove.some(k => line.trim().startsWith(k));
    });

    const newVars = [
        `APP_ID=${appId}`,
        `DVN_KEY_1=${secretKeys[0]}`,
        `DVN_KEY_2=${secretKeys[1]}`,
        `DVN_KEY_3=${secretKeys[2]}`
    ];

    fs.writeFileSync(envPath, [...filteredLines, ...newVars].join('\n').trim() + '\n');
    
    console.log(`\n✅ Saved APP_ID and DVN keys to .env!`);
    console.log("You can now securely push these variables to Render.");
}

deploy().catch(console.error);
