import { randomBytes } from "crypto";
import { checkX402, x402Fetch } from "../runtime/x402.js";
import { TOSRpcClient } from "../tos/client.js";
import type {
  OpenFoxConfig,
  OpenFoxDatabase,
  OpenFoxIdentity,
} from "../types.js";
import {
  buildSignedAgentDiscoveryCard,
  verifyAgentDiscoveryCard,
} from "./card.js";
import {
  normalizeAgentDiscoveryConfig,
  type AgentDiscoveryCard,
  type AgentDiscoveryCardResponse,
  type AgentDiscoveryConfig,
  type AgentDiscoveryInfo,
  type AgentDiscoverySelectionPolicy,
  type AgentDiscoverySearchResult,
  type FaucetInvocationRequest,
  type FaucetInvocationResponse,
  type ObservationInvocationRequest,
  type ObservationInvocationResponse,
  type VerifiedAgentProvider,
} from "./types.js";

class AgentDiscoveryRpcClient {
  private readonly rpcUrl: string;
  private nextId = 1;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `TOS RPC ${method} failed: ${response.status} ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new Error(
        `TOS RPC ${method} error ${body.error.code}: ${body.error.message}`,
      );
    }
    return body.result as T;
  }

  getInfo(): Promise<AgentDiscoveryInfo> {
    return this.request("tos_agentDiscoveryInfo", []);
  }

  publish(args: {
    primaryIdentity: string;
    capabilities: string[];
    connectionModes: string[];
    cardJson: string;
    cardSequence: number;
  }): Promise<AgentDiscoveryInfo> {
    return this.request("tos_agentDiscoveryPublish", [args]);
  }

  search(
    capability: string,
    limit: number,
  ): Promise<AgentDiscoverySearchResult[]> {
    return this.request("tos_agentDiscoverySearch", [capability, limit]);
  }

  directorySearch(
    nodeRecord: string,
    capability: string,
    limit: number,
  ): Promise<AgentDiscoverySearchResult[]> {
    return this.request("tos_agentDiscoveryDirectorySearch", [
      nodeRecord,
      capability,
      limit,
    ]);
  }

  getCard(nodeRecord: string): Promise<AgentDiscoveryCardResponse> {
    return this.request("tos_agentDiscoveryGetCard", [nodeRecord]);
  }
}

function requireDiscoveryRpc(config: OpenFoxConfig): AgentDiscoveryRpcClient {
  const rpcUrl = config.tosRpcUrl || process.env.TOS_RPC_URL;
  if (!rpcUrl) {
    throw new Error("TOS RPC is required for Agent Discovery");
  }
  return new AgentDiscoveryRpcClient(rpcUrl);
}

function deriveConnectionModes(agentDiscovery: AgentDiscoveryConfig): string[] {
  const modes = new Set<string>(["talkreq"]);
  for (const endpoint of agentDiscovery.endpoints) {
    if (endpoint.kind === "https" || endpoint.kind === "http") {
      modes.add("https");
    } else if (endpoint.kind === "ws") {
      modes.add("stream");
    }
  }
  return [...modes];
}

function getInvokableEndpoint(
  card: AgentDiscoveryCard,
): VerifiedAgentProvider["endpoint"] | null {
  return (
    card.endpoints.find((endpoint) => endpoint.kind === "https") ??
    card.endpoints.find((endpoint) => endpoint.kind === "http") ??
    card.endpoints.find((endpoint) => endpoint.kind === "ws") ??
    null
  );
}

function parseCardJson(cardJson: string): AgentDiscoveryCard {
  return JSON.parse(cardJson) as AgentDiscoveryCard;
}

function parseBigIntAmount(value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value.trim())) {
    return 0n;
  }
  return BigInt(value.trim());
}

function parseSignedBigInt(value: string | undefined): bigint {
  if (!value || !/^-?\d+$/.test(value.trim())) {
    return 0n;
  }
  return BigInt(value.trim());
}

function buildRequestExpiry(ttlSeconds = 300): number {
  return Math.floor(Date.now() / 1000) + Math.max(30, ttlSeconds);
}

function resolveSelectionPolicy(
  config: OpenFoxConfig,
  override?: Partial<AgentDiscoverySelectionPolicy>,
): AgentDiscoverySelectionPolicy {
  return {
    requireRegistered: true,
    excludeSuspended: true,
    requireOnchainCapability: false,
    minimumStakeWei: "0",
    minimumReputation: "0",
    preferHigherStake: true,
    preferHigherReputation: true,
    ...(config.agentDiscovery?.selectionPolicy ?? {}),
    ...(override ?? {}),
  };
}

function providerMatchesSelectionPolicy(
  provider: VerifiedAgentProvider,
  policy: AgentDiscoverySelectionPolicy,
  requestedAmount: bigint,
): boolean {
  const maxAmount = parseBigIntAmount(provider.matchedCapability.max_amount);
  if (maxAmount !== 0n && requestedAmount > maxAmount) {
    return false;
  }

  const trust = provider.search.trust;
  if (!trust) {
    return true;
  }
  if (policy.requireRegistered && !trust.registered) {
    return false;
  }
  if (policy.excludeSuspended && trust.suspended) {
    return false;
  }
  if (
    policy.requireOnchainCapability &&
    trust.capabilityRegistered &&
    !trust.hasOnchainCapability
  ) {
    return false;
  }
  if (
    parseBigIntAmount(policy.minimumStakeWei) > parseBigIntAmount(trust.stake)
  ) {
    return false;
  }
  if (
    parseSignedBigInt(policy.minimumReputation) >
    parseSignedBigInt(trust.reputation)
  ) {
    return false;
  }
  return true;
}

function sortProviders(
  providers: VerifiedAgentProvider[],
  requestedAmount: bigint,
  selectionPolicy: AgentDiscoverySelectionPolicy,
): VerifiedAgentProvider[] {
  const scoreMode = (mode: string): number => {
    switch (mode) {
      case "sponsored":
        return 3;
      case "hybrid":
        return 2;
      case "paid":
        return 1;
      default:
        return 0;
    }
  };

  return providers
    .filter((provider) =>
      providerMatchesSelectionPolicy(
        provider,
        selectionPolicy,
        requestedAmount,
      ),
    )
    .sort((left, right) => {
      const leftMode = scoreMode(left.matchedCapability.mode);
      const rightMode = scoreMode(right.matchedCapability.mode);
      if (leftMode !== rightMode) {
        return rightMode - leftMode;
      }
      const leftTrust = left.search.trust;
      const rightTrust = right.search.trust;
      if (
        (leftTrust?.registered ?? false) !== (rightTrust?.registered ?? false)
      ) {
        return rightTrust?.registered ? 1 : -1;
      }
      if (
        (leftTrust?.hasOnchainCapability ?? false) !==
        (rightTrust?.hasOnchainCapability ?? false)
      ) {
        return rightTrust?.hasOnchainCapability ? 1 : -1;
      }
      if (selectionPolicy.preferHigherReputation) {
        const leftRep = parseSignedBigInt(leftTrust?.reputation);
        const rightRep = parseSignedBigInt(rightTrust?.reputation);
        if (leftRep !== rightRep) {
          return rightRep > leftRep ? 1 : -1;
        }
      }
      if (selectionPolicy.preferHigherStake) {
        const leftStake = parseBigIntAmount(leftTrust?.stake);
        const rightStake = parseBigIntAmount(rightTrust?.stake);
        if (leftStake !== rightStake) {
          return rightStake > leftStake ? 1 : -1;
        }
      }
      const leftRatings = parseBigIntAmount(leftTrust?.ratingCount);
      const rightRatings = parseBigIntAmount(rightTrust?.ratingCount);
      if (leftRatings !== rightRatings) {
        return rightRatings > leftRatings ? 1 : -1;
      }
      const leftAmount = parseBigIntAmount(left.matchedCapability.max_amount);
      const rightAmount = parseBigIntAmount(right.matchedCapability.max_amount);
      if (leftAmount !== rightAmount) {
        return rightAmount > leftAmount ? 1 : -1;
      }
      return (right.card.card_seq || 0) - (left.card.card_seq || 0);
    });
}

async function collectSearchResults(
  rpc: AgentDiscoveryRpcClient,
  config: OpenFoxConfig,
  capability: string,
  limit: number,
): Promise<AgentDiscoverySearchResult[]> {
  const merged = new Map<string, AgentDiscoverySearchResult>();
  for (const result of await rpc.search(capability, limit)) {
    merged.set(result.nodeId, result);
  }

  const directoryRecords = config.agentDiscovery?.directoryNodeRecords ?? [];
  for (const nodeRecord of directoryRecords) {
    try {
      for (const result of await rpc.directorySearch(
        nodeRecord,
        capability,
        limit,
      )) {
        if (!merged.has(result.nodeId)) {
          merged.set(result.nodeId, result);
        }
      }
    } catch {
      continue;
    }
  }

  return [...merged.values()].slice(0, limit);
}

async function endpointSupportsDeclaredMode(
  provider: VerifiedAgentProvider,
): Promise<boolean> {
  if (provider.endpoint.kind === "ws") {
    return (
      provider.endpoint.url.startsWith("ws://") ||
      provider.endpoint.url.startsWith("wss://")
    );
  }
  if (provider.matchedCapability.mode === "paid") {
    return (await checkX402(provider.endpoint.url)) !== null;
  }
  return (
    (provider.endpoint.kind === "https" &&
      provider.endpoint.url.startsWith("https://")) ||
    (provider.endpoint.kind === "http" &&
      provider.endpoint.url.startsWith("http://"))
  );
}

export async function publishLocalAgentDiscoveryCard(params: {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  tosAddress: string;
  db?: OpenFoxDatabase;
}): Promise<{ info: AgentDiscoveryInfo; card: AgentDiscoveryCard } | null> {
  const agentDiscovery = normalizeAgentDiscoveryConfig(
    params.config.agentDiscovery,
  );
  if (!agentDiscovery) {
    return null;
  }

  const rpc = requireDiscoveryRpc(params.config);
  const info = await rpc.getInfo();
  if (!info.enabled || !info.nodeRecord) {
    throw new Error(
      "Agent Discovery is not enabled on the connected GTOS node",
    );
  }
  if (!info.nodeId) {
    throw new Error("GTOS node did not return a discovery node ID");
  }

  const card = await buildSignedAgentDiscoveryCard({
    identity: params.identity,
    config: params.config,
    agentDiscovery,
    tosAddress: params.tosAddress,
    discoveryNodeId: info.nodeId,
  });

  const published = await rpc.publish({
    primaryIdentity: params.tosAddress,
    capabilities: card.capabilities.map((capability) => capability.name),
    connectionModes: deriveConnectionModes(agentDiscovery),
    cardJson: JSON.stringify(card),
    cardSequence: card.card_seq,
  });

  params.db?.setKV("agent_discovery:last_published_card", JSON.stringify(card));
  params.db?.setKV(
    "agent_discovery:last_published_at",
    new Date().toISOString(),
  );

  return { info: published, card };
}

export async function discoverCapabilityProviders(params: {
  config: OpenFoxConfig;
  capability: string;
  limit?: number;
  selectionPolicy?: Partial<AgentDiscoverySelectionPolicy>;
}): Promise<VerifiedAgentProvider[]> {
  const rpc = requireDiscoveryRpc(params.config);
  const searchResults = await collectSearchResults(
    rpc,
    params.config,
    params.capability,
    params.limit ?? 10,
  );
  const providers: VerifiedAgentProvider[] = [];

  for (const search of searchResults) {
    try {
      const cardResponse = await rpc.getCard(search.nodeRecord);
      const card = parseCardJson(cardResponse.cardJson);
      const valid = await verifyAgentDiscoveryCard(card, search.nodeId);
      if (!valid) {
        continue;
      }
      const matchedCapability = card.capabilities.find(
        (capability) => capability.name === params.capability,
      );
      const endpoint = getInvokableEndpoint(card);
      if (!matchedCapability || !endpoint) {
        continue;
      }
      const provider: VerifiedAgentProvider = {
        search,
        card,
        matchedCapability,
        endpoint,
      };
      if (!(await endpointSupportsDeclaredMode(provider))) {
        continue;
      }
      providers.push(provider);
    } catch {
      continue;
    }
  }

  return sortProviders(
    providers,
    0n,
    resolveSelectionPolicy(params.config, params.selectionPolicy),
  );
}

export async function requestTestnetFaucet(params: {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  tosAddress: string;
  requestedAmountWei: bigint;
  capability?: string;
  reason?: string;
  limit?: number;
  waitForReceipt?: boolean;
  db?: OpenFoxDatabase;
  selectionPolicy?: Partial<AgentDiscoverySelectionPolicy>;
}): Promise<{
  provider: VerifiedAgentProvider;
  request: FaucetInvocationRequest;
  response: FaucetInvocationResponse;
  receipt?: Record<string, unknown> | null;
}> {
  const capability = params.capability ?? "sponsor.topup.testnet";
  const providers = await discoverCapabilityProviders({
    config: params.config,
    capability,
    limit: params.limit ?? 10,
    selectionPolicy: params.selectionPolicy,
  });
  const ranked = sortProviders(
    providers,
    params.requestedAmountWei,
    resolveSelectionPolicy(params.config, params.selectionPolicy),
  );
  if (!ranked.length) {
    throw new Error(`No provider found for capability ${capability}`);
  }

  const provider = ranked[0];
  const request: FaucetInvocationRequest = {
    capability,
    requester: {
      agent_id: params.config.agentId || params.identity.address.toLowerCase(),
      identity: {
        kind: "tos",
        value: params.tosAddress.toLowerCase(),
      },
    },
    request_nonce: randomBytes(16).toString("hex"),
    request_expires_at: buildRequestExpiry(),
    requested_amount: params.requestedAmountWei.toString(),
    reason: params.reason || "bootstrap openfox wallet",
  };

  const result = await x402Fetch(
    provider.endpoint.url,
    params.identity.account,
    "POST",
    JSON.stringify(request),
    { Accept: "application/json" },
  );
  if (!result.success) {
    throw new Error(
      result.error || `Provider request failed with status ${result.status}`,
    );
  }

  const response =
    typeof result.response === "string"
      ? (JSON.parse(result.response) as FaucetInvocationResponse)
      : (result.response as FaucetInvocationResponse);
  if (!response || typeof response.status !== "string") {
    throw new Error("Provider returned an invalid faucet response");
  }

  let receipt: Record<string, unknown> | null | undefined;
  const receiptRpcUrl = params.config.tosRpcUrl || process.env.TOS_RPC_URL;
  if (
    params.waitForReceipt &&
    response.status === "approved" &&
    response.tx_hash &&
    receiptRpcUrl
  ) {
    const client = new TOSRpcClient({ rpcUrl: receiptRpcUrl });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      receipt = await client.getTransactionReceipt(
        response.tx_hash as `0x${string}`,
      );
      if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  params.db?.setKV(
    "agent_discovery:last_faucet_event",
    JSON.stringify({
      at: new Date().toISOString(),
      providerNodeId: provider.search.nodeId,
      capability,
      request,
      response,
      receipt,
    }),
  );

  return { provider, request, response, receipt };
}

export async function requestObservationOnce(params: {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  tosAddress: string;
  targetUrl: string;
  capability?: string;
  reason?: string;
  limit?: number;
  db?: OpenFoxDatabase;
  selectionPolicy?: Partial<AgentDiscoverySelectionPolicy>;
}): Promise<{
  provider: VerifiedAgentProvider;
  request: ObservationInvocationRequest;
  response: ObservationInvocationResponse;
}> {
  const capability = params.capability ?? "observation.once";
  const providers = await discoverCapabilityProviders({
    config: params.config,
    capability,
    limit: params.limit ?? 10,
    selectionPolicy: params.selectionPolicy,
  });
  const ranked = sortProviders(
    providers,
    0n,
    resolveSelectionPolicy(params.config, params.selectionPolicy),
  );
  if (!ranked.length) {
    throw new Error(`No provider found for capability ${capability}`);
  }
  const provider =
    ranked.find((entry) => entry.matchedCapability.mode === "paid") ??
    ranked[0];
  const request: ObservationInvocationRequest = {
    capability,
    requester: {
      agent_id: params.config.agentId || params.identity.address.toLowerCase(),
      identity: {
        kind: "tos",
        value: params.tosAddress.toLowerCase(),
      },
    },
    request_nonce: randomBytes(16).toString("hex"),
    request_expires_at: buildRequestExpiry(),
    target_url: params.targetUrl,
    reason: params.reason || "one-shot paid observation",
  };

  const result = await x402Fetch(
    provider.endpoint.url,
    params.identity.account,
    "POST",
    JSON.stringify(request),
    { Accept: "application/json" },
  );
  if (!result.success) {
    throw new Error(
      result.error || `Provider request failed with status ${result.status}`,
    );
  }
  const response =
    typeof result.response === "string"
      ? (JSON.parse(result.response) as ObservationInvocationResponse)
      : (result.response as ObservationInvocationResponse);
  if (!response || response.status !== "ok") {
    throw new Error("Provider returned an invalid observation response");
  }
  params.db?.setKV(
    "agent_discovery:last_observation_event",
    JSON.stringify({
      at: new Date().toISOString(),
      providerNodeId: provider.search.nodeId,
      capability,
      request,
      response,
    }),
  );
  return { provider, request, response };
}
