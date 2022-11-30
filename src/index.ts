import { mnemonicToSeedSync } from 'bip39';
import { fromHex, PrivateKey, toHex } from 'chia-bls';
import { Coin, formatHex, FullNode, sanitizeHex, toCoinId } from 'chia-rpc';
import { KeyStore, StandardWallet } from 'chia-wallet-lib';
import { Program } from 'clvm-lib';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';

dotenv.config();

const mnemonic = process.env.MNEMONIC!;
const privateKey = PrivateKey.fromSeed(mnemonicToSeedSync(mnemonic));

const dir = path.join(__dirname, '..');

const messagePuzzle = Program.deserializeHex(
    fs.readFileSync(path.join(dir, 'message.clsp.hex'), 'utf-8')
);

const node = new FullNode(os.homedir() + '/.chia/mainnet');
const keyStore = new KeyStore(privateKey);

const wallet = new StandardWallet(node, keyStore);
const genesis = fromHex(process.env.GENESIS!);

const amount = 1;
const fee = 0.00005e12;

async function newInstance(initialMessage: Program) {
    await wallet.sync();

    const spend = wallet.createSpend();

    // Curry the puzzle
    const puzzle = messagePuzzle.curry([
        // Mod hash
        Program.fromBytes(messagePuzzle.hash()),

        // Message is empty until the eve is spent
        Program.nil,
    ]);

    // Create the eve coin
    const send = await wallet.send(puzzle.hash(), amount, fee);
    spend.coin_spends.push(...send);

    // Calculate the root coin id
    const eveCoin: Coin = {
        parent_coin_info: formatHex(toHex(toCoinId(send[0].coin))),
        puzzle_hash: formatHex(puzzle.hashHex()),
        amount,
    };

    // Create the eve solution
    const solution = Program.fromList([
        // Message
        initialMessage,

        // Amount
        Program.fromInt(amount),
    ]);

    // Spend the eve coin
    spend.coin_spends.push({
        coin: eveCoin,
        puzzle_reveal: puzzle.serializeHex(),
        solution: solution.serializeHex(),
    });

    // Sign the wallet spend
    wallet.signSpend(spend, genesis);

    // Complete the transaction
    console.log('Eve coin id:', toHex(toCoinId(eveCoin)));
    console.log(await node.pushTx(spend));
}

interface SyncInfo {
    parent: string;
    current: string;
}

async function sync(): Promise<SyncInfo> {
    const eveCoinId = process.env.EVE_COIN_ID!;

    let current = eveCoinId;
    let parent = current;

    while (true) {
        // Fetch coins created by the current coin
        const coinRecords = await node.getCoinRecordsByParentIds(
            [current],
            undefined,
            undefined,
            true
        );
        if (!coinRecords.success) throw new Error(coinRecords.error);

        // If there are none, we are already synced
        if (!coinRecords.coin_records.length) break;

        // Update the parent
        parent = current;

        // Continue with the child coin as the new singleton
        const coinRecord = coinRecords.coin_records[0];
        current = toHex(toCoinId(coinRecord.coin));
    }

    return {
        parent,
        current,
    };
}

async function getMessage(syncInfo: SyncInfo): Promise<Program> {
    const coinRecord = await node.getCoinRecordByName(syncInfo.parent);
    if (!coinRecord.success) throw new Error(coinRecord.error);

    const puzzleAndSolution = await node.getPuzzleAndSolution(
        syncInfo.parent,
        coinRecord.coin_record.spent_block_index
    );
    if (!puzzleAndSolution.success) throw new Error(puzzleAndSolution.error);

    const spend = puzzleAndSolution.coin_solution;

    const solution = Program.deserializeHex(
        sanitizeHex(spend.solution)
    ).toList();

    return solution[0];
}

async function printMessage() {
    const syncInfo = await sync();
    const message = await getMessage(syncInfo);
    console.log('Message:', message.toString());
}

async function setMessage(newMessage: Program) {
    await wallet.sync();

    const syncInfo = await sync();
    const message = await getMessage(syncInfo);

    // Fetch the coin record
    const coinRecord = await node.getCoinRecordByName(syncInfo.current);
    if (!coinRecord.success) throw new Error(coinRecord.error);

    const coin = coinRecord.coin_record.coin;

    const spend = wallet.createSpend();

    // Create the current puzzle
    const puzzle = messagePuzzle.curry([
        Program.fromBytes(messagePuzzle.hash()),
        message,
    ]);

    // Create the solution
    const solution = Program.fromList([
        newMessage,
        Program.fromInt(coin.amount),
    ]);

    spend.coin_spends.push({
        // Spend the current singleton
        coin,

        // The puzzle reveal contains the old message
        puzzle_reveal: puzzle.serializeHex(),

        // Spend it with the new message
        solution: solution.serializeHex(),
    });

    const send = await wallet.sendFee(fee);

    spend.coin_spends.push(...send);

    wallet.signSpend(spend, genesis);

    console.log(await node.pushTx(spend));
}

// newInstance(Program.fromText('Hello, world!'));
// printMessage();
// setMessage(Program.fromText('Goodbye, world!'));
