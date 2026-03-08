declare module "@conway/automaton/config.js" {
  export interface AutomatonCliConfig {
    name: string;
    walletAddress: string;
    tosWalletAddress?: string;
    tosRpcUrl?: string;
    tosChainId?: number;
    creatorAddress: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    inferenceModelRef?: string;
    conwayApiUrl?: string;
    conwayApiKey?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    socialRelayUrl?: string;
  }

  export function loadConfig(): AutomatonCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "@conway/automaton/identity/wallet.js" {
  export function loadWalletPrivateKey(): `0x${string}` | null;
}

declare module "@conway/automaton/tos/address.js" {
  export type TOSAddress = `0x${string}`;

  export function deriveTOSAddressFromPrivateKey(privateKey: `0x${string}`): TOSAddress;
  export function normalizeTOSAddress(value: string): TOSAddress;
}

declare module "@conway/automaton/tos/client.js" {
  import type { TOSAddress } from "@conway/automaton/tos/address.js";

  export class TOSRpcClient {
    constructor(options: { rpcUrl: string });
    getChainId(): Promise<bigint>;
    getBalance(address: TOSAddress, blockTag?: string): Promise<bigint>;
    getTransactionCount(address: TOSAddress, blockTag?: string): Promise<bigint>;
  }

  export function formatTOSNetwork(chainId: bigint | number): string;
  export function parseTOSAmount(amount: string): bigint;
  export function sendTOSNativeTransfer(params: {
    rpcUrl: string;
    privateKey: `0x${string}`;
    to: TOSAddress | string;
    amountWei: bigint;
    gas?: bigint;
    data?: `0x${string}`;
    waitForReceipt?: boolean;
    receiptTimeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<{
    signed: {
      nonce: bigint;
      gas: bigint;
      rawTransaction: `0x${string}`;
    };
    txHash: `0x${string}`;
    receipt?: Record<string, unknown> | null;
  }>;
}

declare module "@conway/automaton/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface AutomatonCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
  }

  export function createDatabase(path: string): AutomatonCliDatabase;
}
