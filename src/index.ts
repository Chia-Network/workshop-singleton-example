import { mnemonicToSeedSync } from 'bip39';
import { fromHex, PrivateKey, toHex } from 'chia-bls';
import { Coin, formatHex, FullNode, sanitizeHex, toCoinId } from 'chia-rpc';
import { KeyStore, StandardWallet } from 'chia-wallet-lib';
import { Program } from 'clvm-lib';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SingletonInfo } from './SingletonInfo';

dotenv.config();

const mnemonic = process.env.MNEMONIC!;
const privateKey = PrivateKey.fromSeed(mnemonicToSeedSync(mnemonic));

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

const fee = 0.00005e12;

async function launch(message: Program) {
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

    // Create the inner puzzle
    const innerPuzzle = messagePuzzle.curry([
        // Mod hash
        Program.fromBytes(messagePuzzle.hash()),

        // Message is empty until eve spend
        Program.nil,
    ]);

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
        innerPuzzle,
    ]);

    const solution = Program.fromList([
        // Curried singleton puzzle hash
        Program.fromBytes(singleton.hash()),

        // Amount
        Program.fromInt(amount),

        // Key value list
        Program.nil,
    ]);

    // Create the eve singleton
    spend.coin_spends.push({
        coin: launcherCoin,
        puzzle_reveal: launcherPuzzle.serializeHex(),
        solution: solution.serializeHex(),
    });

    const innerSolution = Program.fromList([message, Program.fromInt(amount)]);

    const eveSolution = Program.fromList([
        // Lineage proof
        Program.fromList([
            // Parent coin info
            Program.fromBytes(launcherId),

            // Amount
            Program.fromInt(amount),
        ]),

        // Amount
        Program.fromInt(amount),

        // Inner solution
        innerSolution,
    ]);

    // Spend the eve singleton
    spend.coin_spends.push({
        coin: {
            parent_coin_info: formatHex(toHex(toCoinId(launcherCoin))),
            puzzle_hash: formatHex(singleton.hashHex()),
            amount,
        },
        puzzle_reveal: singleton.serializeHex(),
        solution: eveSolution.serializeHex(),
    });

    // Sign the wallet spend
    wallet.signSpend(spend, genesis);

    // Complete the transaction
    console.log('Launcher id:', toHex(launcherId));
    console.log(await node.pushTx(spend));
}

async function sync(): Promise<SingletonInfo> {
    const launcherId = process.env.LAUNCHER_ID!;

    let singleton = launcherId;
    let parent = singleton;

    while (true) {
        // Fetch coins created by the singleton
        const coinRecords = await node.getCoinRecordsByParentIds(
            [singleton],
            undefined,
            undefined,
            true
        );
        if (!coinRecords.success) throw new Error(coinRecords.error);

        // If there are none, the singleton is synced
        if (!coinRecords.coin_records.length) break;

        parent = singleton;

        // Continue with the child coin as the new singleton
        const coinRecord = coinRecords.coin_records[0];
        singleton = toHex(toCoinId(coinRecord.coin));
    }

    // Get the parent coin record
    const parentCoinRecord = await node.getCoinRecordByName(parent);
    if (!parentCoinRecord.success) throw new Error(parentCoinRecord.error);

    // Get the singleton coin record
    const singletonCoinRecord = await node.getCoinRecordByName(parent);
    if (!singletonCoinRecord.success)
        throw new Error(singletonCoinRecord.error);

    // Get the parent spend
    const puzzleAndSolution = await node.getPuzzleAndSolution(
        parent,
        parentCoinRecord.coin_record.spent_block_index
    );
    if (!puzzleAndSolution.success) throw new Error(puzzleAndSolution.error);

    const spend = puzzleAndSolution.coin_solution;
    const puzzle = Program.deserializeHex(sanitizeHex(spend.puzzle_reveal));

    let message: Program;

    if (puzzle.equals(launcherPuzzle))
        throw new Error(
            'Singleton not launched yet. Perhaps the transaction is still unconfirmed.'
        );

    // Fetch it from the puzzle reveal
    const args = puzzle.uncurry()![1];
    const innerPuzzle = args[1];
    const innerArgs = innerPuzzle.uncurry()![1];
    message = innerArgs[1];

    return {
        launcherId: fromHex(launcherId),
        message,
        parent: parentCoinRecord.coin_record.coin,
        singleton: singletonCoinRecord.coin_record.coin,
    };
}

async function getMessage() {
    const info = await sync();

    console.log(info.message.toText());
}

async function setMessage(newMessage: Program) {
    const info = await sync();

    const spend = wallet.createSpend();

    const singleton = singletonPuzzle.curry([
        // Singleton struct
        Program.cons(
            // Singleton mod hash
            Program.fromBytes(singletonPuzzle.hash()),
            Program.cons(
                // Launcher id
                Program.fromBytes(info.launcherId),

                // Launcher mod hash
                Program.fromBytes(launcherPuzzle.hash())
            )
        ),

        // Inner puzzle
        messagePuzzle.curry([
            Program.fromBytes(messagePuzzle.hash()),
            info.message,
        ]),
    ]);

    const innerSolution = Program.fromList([
        newMessage,
        Program.fromInt(info.singleton.amount),
    ]);

    const solution = Program.fromList([
        // Lineage proof
        Program.fromList([
            // Parent coin info
            Program.fromBytes(toCoinId(info.parent)),

            // Puzzle hash
            Program.fromBytes(fromHex(sanitizeHex(info.singleton.puzzle_hash))),

            // Amount
            Program.fromInt(info.singleton.amount),
        ]),

        // Amount
        Program.fromInt(info.singleton.amount),

        // Inner solution
        innerSolution,
    ]);

    spend.coin_spends.push({
        // Spend the current singleton
        coin: info.singleton,

        // The puzzle reveal contains the old message
        puzzle_reveal: singleton.serializeHex(),

        // Spend it with the new message
        solution: solution.serializeHex(),
    });

    console.log(await node.pushTx(spend));
}

launch(Program.fromText('Hello, world!'));
// getMessage();
// setMessage(Program.fromText('Goodbye, world!'));
