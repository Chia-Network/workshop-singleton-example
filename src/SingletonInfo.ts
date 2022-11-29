import { Coin } from 'chia-rpc';
import { Program } from 'clvm-lib';

export interface SingletonInfo {
    launcherId: Uint8Array;
    message: Program;
    parent: Coin;
    singleton: Coin;
}
