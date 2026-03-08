/**
 * Automaton Configuration
 *
 * Loads and saves ~/.automaton/automaton.json, while also supporting a
 * minimal OpenClaw-compatible config surface in ~/.automaton/openclaw.json.
 */

import fs from "fs";
import path from "path";
import type {
  AutomatonConfig,
  TreasuryPolicy,
  ModelStrategyConfig,
  SoulConfig,
} from "./types.js";
import type { Address } from "viem";
import {
  DEFAULT_CONFIG,
  DEFAULT_TREASURY_POLICY,
  DEFAULT_MODEL_STRATEGY_CONFIG,
  DEFAULT_SOUL_CONFIG,
} from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";

const logger = createLogger("config");
const AUTOMATON_CONFIG_FILENAME = "automaton.json";
const OPENCLAW_COMPAT_FILENAME = "openclaw.json";

type JsonRecord = Record<string, unknown>;

interface OpenClawCompatConfig {
  model?: string;
  modelRef?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
}

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), AUTOMATON_CONFIG_FILENAME);
}

export function getOpenClawCompatConfigPath(): string {
  return path.join(getAutomatonDir(), OPENCLAW_COMPAT_FILENAME);
}

function resolveStateDirPath(...parts: string[]): string {
  return path.join(process.env.HOME || "/root", ...parts);
}

function readJsonFile(filePath: string): JsonRecord | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return typeof raw === "object" && raw !== null ? (raw as JsonRecord) : null;
  } catch (error) {
    logger.warn(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function getNestedRecord(value: unknown, key: string): JsonRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const result = (value as JsonRecord)[key];
  return typeof result === "object" && result !== null ? (result as JsonRecord) : null;
}

function getNestedString(value: unknown, ...pathParts: string[]): string | undefined {
  let cursor: unknown = value;
  for (const part of pathParts) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    cursor = (cursor as JsonRecord)[part];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined;
}

function resolveSecretRef(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  if (match) {
    const envValue = process.env[match[1]];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
  }

  return trimmed;
}

function parseModelRef(modelRef: string | undefined): { model?: string; modelRef?: string } {
  if (!modelRef) {
    return {};
  }

  const trimmed = modelRef.trim();
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) {
    return {
      model: trimmed,
      modelRef: trimmed,
    };
  }

  return {
    model: parts[parts.length - 1],
    modelRef: trimmed,
  };
}

function inferModelRef(config: Pick<AutomatonConfig, "inferenceModel" | "inferenceModelRef" | "openaiApiKey" | "anthropicApiKey" | "ollamaBaseUrl">): string {
  if (config.inferenceModelRef && config.inferenceModelRef.trim()) {
    return config.inferenceModelRef.trim();
  }
  if (config.anthropicApiKey) {
    return `anthropic/${config.inferenceModel}`;
  }
  if (config.ollamaBaseUrl) {
    return `ollama/${config.inferenceModel}`;
  }
  return `openai/${config.inferenceModel}`;
}

function loadOpenClawCompatConfig(): OpenClawCompatConfig {
  const configuredPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const candidates = [
    configuredPath,
    getOpenClawCompatConfigPath(),
    resolveStateDirPath(".openclaw", "openclaw.json"),
  ].filter((value): value is string => !!value);

  for (const filePath of candidates) {
    const raw = readJsonFile(filePath);
    if (!raw) {
      continue;
    }

    const providerRoot = getNestedRecord(getNestedRecord(raw, "models"), "providers");
    const openaiProvider = providerRoot ? getNestedRecord(providerRoot, "openai") : null;
    const anthropicProvider = providerRoot ? getNestedRecord(providerRoot, "anthropic") : null;
    const ollamaProvider =
      (providerRoot ? getNestedRecord(providerRoot, "ollama") : null) ||
      (providerRoot ? getNestedRecord(providerRoot, "local") : null);

    const modelRef =
      getNestedString(raw, "agents", "defaults", "model", "primary") ||
      getNestedString(raw, "agent", "model") ||
      getNestedString(raw, "agent", "model", "primary");

    const { model } = parseModelRef(modelRef);
    const env = getNestedRecord(raw, "env");

    return {
      model,
      modelRef,
      openaiApiKey:
        resolveSecretRef(getNestedString(env, "OPENAI_API_KEY")) ||
        resolveSecretRef(getNestedString(openaiProvider, "apiKey")),
      anthropicApiKey:
        resolveSecretRef(getNestedString(env, "ANTHROPIC_API_KEY")) ||
        resolveSecretRef(getNestedString(anthropicProvider, "apiKey")),
      ollamaBaseUrl:
        resolveSecretRef(getNestedString(env, "OLLAMA_BASE_URL")) ||
        resolveSecretRef(getNestedString(ollamaProvider, "baseUrl")),
    };
  }

  return {};
}

/**
 * Load the automaton config from disk.
 * Merges with defaults and OpenClaw-compatible provider settings.
 */
export function loadConfig(): AutomatonConfig | null {
  const raw = readJsonFile(getConfigPath());
  const compat = loadOpenClawCompatConfig();

  if (!raw) {
    return null;
  }

  const conwayApiKey =
    (typeof process.env.CONWAY_API_KEY === "string" && process.env.CONWAY_API_KEY.trim()) ||
    (raw && typeof raw.conwayApiKey === "string" && raw.conwayApiKey.trim()) ||
    loadApiKeyFromConfig() ||
    undefined;

  const treasuryPolicy: TreasuryPolicy = {
    ...DEFAULT_TREASURY_POLICY,
    ...((raw?.treasuryPolicy as JsonRecord | undefined) ?? {}),
  };

  for (const [key, value] of Object.entries(treasuryPolicy)) {
    if (key === "x402AllowedDomains") continue;
    if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
      logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
      (treasuryPolicy as unknown as JsonRecord)[key] = (DEFAULT_TREASURY_POLICY as unknown as JsonRecord)[key];
    }
  }

  const modelStrategy: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...((raw?.modelStrategy as JsonRecord | undefined) ?? {}),
  };

  const soulConfig: SoulConfig = {
    ...DEFAULT_SOUL_CONFIG,
    ...((raw?.soulConfig as JsonRecord | undefined) ?? {}),
  };

  const modelRef =
    (typeof raw?.inferenceModelRef === "string" && raw.inferenceModelRef.trim()) ||
    compat.modelRef;
  const parsedModelRef = parseModelRef(modelRef);
  const inferenceModel =
    (typeof raw?.inferenceModel === "string" && raw.inferenceModel.trim()) ||
    parsedModelRef.model ||
    compat.model ||
    DEFAULT_CONFIG.inferenceModel ||
    "gpt-5.2";

  if (!modelStrategy.inferenceModel) {
    modelStrategy.inferenceModel = inferenceModel;
  }

  return {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
    registeredWithConway: Boolean(raw?.registeredWithConway && conwayApiKey),
    sandboxId:
      typeof raw?.sandboxId === "string"
        ? raw.sandboxId.trim()
        : DEFAULT_CONFIG.sandboxId || "",
    conwayApiUrl:
      (typeof process.env.CONWAY_API_URL === "string" && process.env.CONWAY_API_URL.trim()) ||
      (typeof raw?.conwayApiUrl === "string" && raw.conwayApiUrl.trim()) ||
      undefined,
    conwayApiKey,
    openaiApiKey:
      (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) ||
      compat.openaiApiKey ||
      (typeof raw?.openaiApiKey === "string" && raw.openaiApiKey.trim()) ||
      undefined,
    anthropicApiKey:
      (typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.trim()) ||
      compat.anthropicApiKey ||
      (typeof raw?.anthropicApiKey === "string" && raw.anthropicApiKey.trim()) ||
      undefined,
    ollamaBaseUrl:
      (typeof process.env.OLLAMA_BASE_URL === "string" && process.env.OLLAMA_BASE_URL.trim()) ||
      compat.ollamaBaseUrl ||
      (typeof raw?.ollamaBaseUrl === "string" && raw.ollamaBaseUrl.trim()) ||
      undefined,
    inferenceModel,
    inferenceModelRef: modelRef,
    tosWalletAddress:
      typeof raw?.tosWalletAddress === "string"
        ? raw.tosWalletAddress.trim()
        : DEFAULT_CONFIG.tosWalletAddress,
    tosRpcUrl:
      typeof process.env.TOS_RPC_URL === "string" && process.env.TOS_RPC_URL.trim()
        ? process.env.TOS_RPC_URL.trim()
        : typeof raw?.tosRpcUrl === "string"
          ? raw.tosRpcUrl.trim()
          : DEFAULT_CONFIG.tosRpcUrl,
    tosChainId:
      typeof raw?.tosChainId === "number"
        ? raw.tosChainId
        : DEFAULT_CONFIG.tosChainId,
    socialRelayUrl:
      typeof raw?.socialRelayUrl === "string" && raw.socialRelayUrl.trim()
        ? raw.socialRelayUrl.trim()
        : undefined,
    treasuryPolicy,
    modelStrategy,
    soulConfig,
  } as AutomatonConfig;
}

function buildOpenClawCompatConfig(config: AutomatonConfig): JsonRecord {
  const modelRef = inferModelRef(config);
  const providers: JsonRecord = {};

  if (config.openaiApiKey) {
    providers.openai = { apiKey: config.openaiApiKey };
  }
  if (config.anthropicApiKey) {
    providers.anthropic = { apiKey: config.anthropicApiKey };
  }
  if (config.ollamaBaseUrl) {
    providers.ollama = {
      baseUrl: config.ollamaBaseUrl.replace(/\/$/, ""),
      apiKey: "ollama",
    };
  }

  return {
    agents: {
      defaults: {
        model: {
          primary: modelRef,
        },
      },
    },
    ...(Object.keys(providers).length > 0
      ? {
          models: {
            providers,
          },
        }
      : {}),
  };
}

/**
 * Save the automaton config to disk and mirror a minimal OpenClaw-compatible
 * config for local/provider-first runtime setup.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });

  fs.writeFileSync(
    getOpenClawCompatConfigPath(),
    JSON.stringify(buildOpenClawCompatConfig(config), null, 2),
    { mode: 0o600 },
  );
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: Address;
  registeredWithConway?: boolean;
  sandboxId: string;
  walletAddress: Address;
  tosWalletAddress?: `0x${string}`;
  tosRpcUrl?: string;
  tosChainId?: number;
  apiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  inferenceModel?: string;
  inferenceModelRef?: string;
  parentAddress?: Address;
  treasuryPolicy?: TreasuryPolicy;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  const inferredModelRef = params.inferenceModelRef?.trim();
  const parsedModelRef = parseModelRef(inferredModelRef);
  const inferenceModel =
    params.inferenceModel?.trim() ||
    parsedModelRef.model ||
    DEFAULT_CONFIG.inferenceModel ||
    "gpt-5.2";

  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: Boolean(params.registeredWithConway && params.apiKey),
    sandboxId: normalizedSandboxId,
    conwayApiUrl: undefined,
    conwayApiKey: params.apiKey?.trim() || undefined,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel,
    inferenceModelRef: inferredModelRef,
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    tosWalletAddress: params.tosWalletAddress,
    tosRpcUrl: params.tosRpcUrl,
    tosChainId: params.tosChainId,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      inferenceModel,
    },
  };
}
