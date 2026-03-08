import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type {
  OpenFoxConfig,
  OpenFoxDatabase,
  OpenFoxIdentity,
} from "../types.js";
import { startAgentDiscoveryFaucetServer } from "../agent-discovery/faucet-server.js";
import { normalizeAgentDiscoveryConfig } from "../agent-discovery/types.js";
import { buildSignedAgentDiscoveryCard } from "../agent-discovery/card.js";
import { startAgentGatewayServer } from "../agent-gateway/server.js";
import { startAgentGatewayProviderSession } from "../agent-gateway/client.js";
import {
  buildGatewayProviderRoutes,
  buildPublishedAgentDiscoveryConfig,
} from "../agent-gateway/publish.js";

const getBalanceMock = vi.fn(async () => 10_000_000_000_000_000_000n);
const sendTransferMock = vi.fn(async () => ({
  signed: {
    nonce: 1n,
    gas: 21_000n,
    rawTransaction: "0xraw",
  },
  txHash: "0xgatewaytxhash",
}));

vi.mock("../tos/client.js", () => ({
  TOSRpcClient: class {
    async getBalance() {
      return getBalanceMock();
    }
  },
  sendTOSNativeTransfer: (...args: unknown[]) => sendTransferMock(...args),
}));

const PROVIDER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f094538e4a2e0d7a5b5d5b4b8b1c1d1e1f1a1b1c" as const;
const GATEWAY_PRIVATE_KEY =
  "0x8b3a350cf5c34c9194ca3a9d8b7f43c795b2d451dc0c6d8f9d7f7a8e9c0d1e2f" as const;

function makeProviderConfig(): OpenFoxConfig {
  return {
    name: "ProviderFox",
    genesisPrompt: "test",
    creatorAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    registeredRemotely: false,
    sandboxId: "",
    runtimeApiUrl: undefined,
    runtimeApiKey: undefined,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    ollamaBaseUrl: undefined,
    inferenceModel: "gpt-5.2",
    maxTokensPerTurn: 4096,
    heartbeatConfigPath: "~/.openfox/heartbeat.yml",
    dbPath: "~/.openfox/state.db",
    logLevel: "info",
    walletAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    tosWalletAddress:
      "0x00000000000000000000000000000000000000000000000000000000000000aa",
    tosRpcUrl: "http://127.0.0.1:8545",
    tosChainId: 1666,
    version: "0.2.1",
    skillsDir: "~/.openfox/skills",
    maxChildren: 3,
    agentDiscovery: {
      enabled: true,
      publishCard: true,
      cardTtlSeconds: 3600,
      endpoints: [],
      capabilities: [],
      directoryNodeRecords: [],
      gatewayClient: {
        enabled: true,
        gatewayAgentId: undefined,
        gatewayUrl: undefined,
        gatewayBootnodes: [],
        sessionTtlSeconds: 3600,
        requestTimeoutMs: 5000,
        routes: [],
      },
      faucetServer: {
        enabled: true,
        bindHost: "127.0.0.1",
        port: 0,
        path: "/agent-discovery/faucet",
        capability: "sponsor.topup.testnet",
        payoutAmountWei: "10000000000000000",
        maxAmountWei: "10000000000000000",
        cooldownSeconds: 60,
        requireTOSIdentity: true,
      },
    },
  };
}

function makeGatewayConfig(): OpenFoxConfig["agentDiscovery"]["gatewayServer"] {
  return {
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    sessionPath: "/agent-gateway/session",
    publicPathPrefix: "/a",
    publicBaseUrl: "http://127.0.0.1:0",
    capability: "gateway.relay",
    mode: "sponsored",
    priceModel: "sponsored",
    sessionTtlSeconds: 3600,
    requestTimeoutMs: 5000,
    maxRoutesPerSession: 8,
    maxRequestBodyBytes: 131072,
  };
}

function makeIdentity(privateKey: `0x${string}`, name: string): OpenFoxIdentity {
  const account = privateKeyToAccount(privateKey);
  return {
    name,
    address: account.address,
    account,
    creatorAddress: account.address,
    sandboxId: "",
    apiKey: "",
    createdAt: new Date().toISOString(),
  };
}

function makeDb(): OpenFoxDatabase {
  const store = new Map<string, string>();
  return {
    getKV(key: string) {
      return store.get(key);
    },
    setKV(key: string, value: string) {
      store.set(key, value);
    },
  } as OpenFoxDatabase;
}

describe("agent gateway", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("relays a faucet capability through a gateway-backed public endpoint", async () => {
    const providerConfig = makeProviderConfig();
    const providerIdentity = makeIdentity(PROVIDER_PRIVATE_KEY, "ProviderFox");
    const providerDb = makeDb();
    const gatewayIdentity = makeIdentity(GATEWAY_PRIVATE_KEY, "GatewayFox");

    const faucetServer = await startAgentDiscoveryFaucetServer({
      identity: providerIdentity,
      config: providerConfig,
      tosAddress: providerConfig.tosWalletAddress!,
      privateKey: PROVIDER_PRIVATE_KEY,
      db: providerDb,
      faucetConfig: providerConfig.agentDiscovery!.faucetServer!,
    });

    const gatewayServer = await startAgentGatewayServer({
      identity: gatewayIdentity,
      db: makeDb(),
      gatewayConfig: makeGatewayConfig()!,
    });

    providerConfig.agentDiscovery!.gatewayClient = {
      ...providerConfig.agentDiscovery!.gatewayClient!,
      enabled: true,
      gatewayAgentId: gatewayServer.gatewayAgentId,
      gatewayUrl: gatewayServer.sessionUrl,
    };

    const routes = buildGatewayProviderRoutes({
      config: providerConfig,
      faucetUrl: faucetServer.url,
    });

    const providerSession = await startAgentGatewayProviderSession({
      identity: providerIdentity,
      config: providerConfig,
      tosAddress: providerConfig.tosWalletAddress!,
      routes,
    });

    const baseConfig = normalizeAgentDiscoveryConfig(providerConfig.agentDiscovery)!;
    const publishedConfig = buildPublishedAgentDiscoveryConfig({
      baseConfig,
      providerSession,
      providerRoutes: routes,
    });
    const card = await buildSignedAgentDiscoveryCard({
      identity: providerIdentity,
      config: providerConfig,
      agentDiscovery: publishedConfig,
      tosAddress: providerConfig.tosWalletAddress!,
      discoveryNodeId: "node-provider",
    });
    const endpoint = card.endpoints.find(
      (entry) => entry.url.includes(`/a/${providerSession.sessionId}/faucet`),
    );

    try {
      expect(endpoint?.via_gateway).toBe(gatewayServer.gatewayAgentId);
      expect(endpoint?.kind).toBe("http");

      const response = await fetch(endpoint!.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: "sponsor.topup.testnet",
          requester: {
            agent_id: "requester",
            identity: {
              kind: "tos",
              value:
                "0x0000000000000000000000000000000000000000000000000000000000000042",
            },
          },
          request_nonce: "gateway-nonce-1",
          request_expires_at: Math.floor(Date.now() / 1000) + 120,
          requested_amount: "9000000000000000",
          reason: "bootstrap",
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        tx_hash: string;
        amount: string;
      };
      expect(body.status).toBe("approved");
      expect(body.tx_hash).toBe("0xgatewaytxhash");
      expect(body.amount).toBe("9000000000000000");
      expect(sendTransferMock).toHaveBeenCalledTimes(1);
    } finally {
      await providerSession.close();
      await gatewayServer.close();
      await faucetServer.close();
    }
  });

  it("discovers a gateway.relay provider before falling back to bootnodes", async () => {
    const providerConfig = makeProviderConfig();
    providerConfig.tosRpcUrl = "http://agent-discovery.test/rpc";
    providerConfig.agentDiscovery!.gatewayClient = {
      ...providerConfig.agentDiscovery!.gatewayClient!,
      enabled: true,
      gatewayAgentId: undefined,
      gatewayUrl: undefined,
      gatewayBootnodes: [],
    };

    const providerIdentity = makeIdentity(PROVIDER_PRIVATE_KEY, "ProviderFox");
    const gatewayIdentity = makeIdentity(GATEWAY_PRIVATE_KEY, "GatewayFox");
    const gatewayServer = await startAgentGatewayServer({
      identity: gatewayIdentity,
      db: makeDb(),
      gatewayConfig: makeGatewayConfig()!,
    });

    const gatewayCard = await buildSignedAgentDiscoveryCard({
      identity: gatewayIdentity,
      config: {
        ...providerConfig,
        agentDiscovery: {
          ...providerConfig.agentDiscovery!,
          endpoints: [{ kind: "ws", url: gatewayServer.sessionUrl }],
          capabilities: [
            {
              name: "gateway.relay",
              mode: "sponsored",
              priceModel: "sponsored",
            },
          ],
        },
      },
      agentDiscovery: {
        ...providerConfig.agentDiscovery!,
        endpoints: [{ kind: "ws", url: gatewayServer.sessionUrl }],
        capabilities: [
          {
            name: "gateway.relay",
            mode: "sponsored",
            priceModel: "sponsored",
          },
        ],
      },
      tosAddress:
        "0x00000000000000000000000000000000000000000000000000000000000000bb",
      discoveryNodeId: "node-gateway",
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "http://agent-discovery.test/rpc") {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
        };
        switch (body.method) {
          case "tos_agentDiscoverySearch":
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: [
                  {
                    nodeId: "node-gateway",
                    nodeRecord: "enr:gateway",
                    primaryIdentity:
                      "0x00000000000000000000000000000000000000000000000000000000000000bb",
                    trust: {
                      registered: true,
                      suspended: false,
                      stake: "10",
                      reputation: "5",
                      ratingCount: "2",
                      capabilityRegistered: true,
                      hasOnchainCapability: true,
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          case "tos_agentDiscoveryGetCard":
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  nodeId: "node-gateway",
                  nodeRecord: "enr:gateway",
                  cardJson: JSON.stringify(gatewayCard),
                },
              }),
              { status: 200 },
            );
        }
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const session = await startAgentGatewayProviderSession({
      identity: providerIdentity,
      config: providerConfig,
      tosAddress: providerConfig.tosWalletAddress!,
      db: makeDb(),
      routes: [
        {
          path: "/faucet",
          capability: "sponsor.topup.testnet",
          mode: "sponsored",
          targetUrl: "http://127.0.0.1:9/unused",
        },
      ],
    });

    try {
      expect(session.gatewayAgentId).toBe(gatewayIdentity.address.toLowerCase());
      expect(session.gatewayUrl).toBe(gatewayServer.sessionUrl);
      expect(session.allocatedEndpoints).toHaveLength(1);
    } finally {
      await session.close();
      await gatewayServer.close();
    }
  });
});
