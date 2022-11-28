import { mnemonicToSeedSync } from 'bip39';
import { fromHex, PrivateKey, toHex } from 'chia-bls';
import { Coin, formatHex, FullNode, toCoinId } from 'chia-rpc';
import { KeyStore, signSpendBundle, StandardWallet } from 'chia-wallet-lib';
import { Program } from 'clvm-lib';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';

dotenv.config();

const mnemonic = process.env.MNEMONIC!;
const privateKey = PrivateKey.fromSeed(mnemonicToSeedSync(mnemonic));
const publicKey = privateKey.getG1();

const dir = path.join(__dirname, '..');
const launcherPuzzle = Program.deserializeHex(
    fs.readFileSync(path.join(dir, 'launcher.clsp.hex'), 'utf-8')
);
const singletonPuzzle = Program.deserializeHex(
    fs.readFileSync(path.join(dir, 'singleton.clsp.hex'), 'utf-8')
);
const messagePuzzle = Program.deserializeHex(
    fs.readFileSync(path.join(dir, 'message.clsp.hex'), 'utf-8')
);

const node = new FullNode(os.homedir() + '/.chia/mainnet');
const keyStore = new KeyStore(privateKey);

const wallet = new StandardWallet(node, keyStore);
const genesis = fromHex(process.env.GENESIS!);

const message = messagePuzzle.curry([
    // Mod hash
    Program.fromBytes(messagePuzzle.hash()),

    // Public key
    Program.fromJacobianPoint(publicKey),

    // Message
    Program.fromText('Hello, world!'),
]);

const fee = 0.00005e12;

async function launch() {
    await wallet.sync();

    const spend = wallet.createSpend();

    const amount = 1;

    // Create the launcher coin
    const send = await wallet.send(launcherPuzzle.hash(), amount, fee);
    spend.coin_spends.push(...send);

    // Find the coin we are spending from the wallet
    const parentCoinId = toCoinId(send[0].coin);

    // Infer the launcher coin we are creating
    const launcherCoin: Coin = {
        parent_coin_info: formatHex(toHex(parentCoinId)),
        puzzle_hash: formatHex(launcherPuzzle.hashHex()),
        amount,
    };

    // Calculate the launcher id
    const launcherId = toCoinId(launcherCoin);

    // Create the singleton
    const singleton = singletonPuzzle.curry([
        // Singleton struct
        Program.cons(
            // Singleton mod hash
            Program.fromBytes(singletonPuzzle.hash()),
            Program.cons(
                // Launcher id
                Program.fromBytes(launcherId),

                // Launcher mod hash
                Program.fromBytes(launcherPuzzle.hash())
            )
        ),

        // Inner puzzle
        message,
    ]);

    const solution = Program.fromList([
        // Curried singleton puzzle hash
        Program.fromBytes(singleton.hash()),

        // Amount
        Program.fromInt(amount),

        // Key value list
        Program.nil,
    ]);

    // Create the singleton
    spend.coin_spends.push({
        coin: launcherCoin,
        puzzle_reveal: launcherPuzzle.serializeHex(),
        solution: solution.serializeHex(),
    });

    // Sign the singleton spend
    signSpendBundle(spend, genesis, true, privateKey);

    // Sign the wallet spend
    wallet.signSpend(spend, genesis);

    // Complete the transaction
    console.log('Launcher id:', toHex(launcherId));
    console.log(await node.pushTx(spend));
}

launch();
