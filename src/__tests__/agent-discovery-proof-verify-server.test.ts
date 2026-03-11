import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "tosdk/accounts";
import {
  DEFAULT_PROOF_VERIFY_SKILL_STAGES,
  DEFAULT_PROVIDER_BACKEND_MODE,
} from "../agent-discovery/provider-skill-spec.js";
import type { OpenFoxConfig, OpenFoxDatabase, OpenFoxIdentity } from "../types.js";
import { createDatabase } from "../state/database.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f094538e4a2e0d7a5b5d5b4b8b1c1d1e1f1a1b1c" as const;
const SUBJECT_SHA =
  "0x5c9799ab4b4d5d9e77c982b6914b4094c343f9d52966698218510d168c2ce9a6";

function makeConfig(): OpenFoxConfig {
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
    walletAddress: "0x0000000000000000000000000000000000000000000000000000000000000042",
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 1666,
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
      proofVerifyServer: {
        enabled: true,
        bindHost: "127.0.0.1",
        port: 0,
        path: "/agent-discovery/proof-verify",
        capability: "proof.verify",
        priceWei: "2000000000000000",
        maxPayloadChars: 16384,
        requestTimeoutMs: 5000,
        maxFetchBytes: 65536,
        allowPrivateTargets: true,
        backendMode: DEFAULT_PROVIDER_BACKEND_MODE,
        skillStages: DEFAULT_PROOF_VERIFY_SKILL_STAGES.map((stage) => ({ ...stage })),
      },
    },
  };
}

function makeIdentity(): OpenFoxIdentity {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return {
    name: "ProviderFox",
    address: account.address,
    account,
    creatorAddress: account.address,
    sandboxId: "",
    apiKey: "",
    createdAt: new Date().toISOString(),
  };
}

function makeDb(root: string): OpenFoxDatabase {
  return createDatabase(path.join(root, ".openfox", "state.db"));
}

describe("agent discovery proof.verify server", () => {
  const originalFetch = global.fetch;
  const originalHome = process.env.HOME;
  const originalTosRpcUrl = process.env.TOS_RPC_URL;
  let tempHome = "";

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTosRpcUrl === undefined) delete process.env.TOS_RPC_URL;
    else process.env.TOS_RPC_URL = originalTosRpcUrl;
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("verifies bundle and subject hashes through the bounded verifier backend", async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-proof-verify-"));
    process.env.HOME = tempHome;
    process.env.TOS_RPC_URL = "http://127.0.0.1:8545";
    fs.mkdirSync(path.join(tempHome, ".openfox"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, ".openfox", "wallet.json"),
      JSON.stringify({ privateKey: TEST_PRIVATE_KEY, createdAt: new Date().toISOString() }),
    );

    const config = makeConfig();
    const { startAgentDiscoveryProofVerifyServer } = await import("../agent-discovery/proof-verify-server.js");
    const { x402Fetch } = await import("../runtime/x402.js");
    const db = makeDb(tempHome);
    const server = await startAgentDiscoveryProofVerifyServer({
      identity: makeIdentity(),
      config,
      address: config.walletAddress!,
      db,
      proofVerifyConfig: config.agentDiscovery!.proofVerifyServer!,
    });

    const requester = makeIdentity();
    let submittedPayments = 0;
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === config.rpcUrl) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
        switch (body.method) {
          case "tos_chainId":
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x682" }), { status: 200 });
          case "tos_getTransactionReceipt":
          case "tos_getTransactionByHash":
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), { status: 200 });
          case "tos_getTransactionCount":
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }), { status: 200 });
          case "tos_sendRawTransaction":
            submittedPayments += 1;
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0xpay${submittedPayments}` }), { status: 200 });
          default:
            throw new Error(`unexpected RPC method ${body.method}`);
        }
      }
      if (url === "https://news.example/article.txt") {
        return new Response("proof verify subject payload", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (url === "https://proofs.example/bundle.json") {
        return new Response(
          JSON.stringify({
            article_sha256: SUBJECT_SHA,
            verifier_backend: "bounded_http_capture_v0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input as RequestInfo | URL, init);
    }) as typeof fetch;

    try {
      const body = {
        capability: "proof.verify",
        requester: {
          agent_id: requester.address.toLowerCase(),
          identity: { kind: "tos", value: requester.address.toLowerCase() },
        },
        request_nonce: "proofverifynonce1",
        request_expires_at: Math.floor(Date.now() / 1000) + 300,
        subject_url: "https://news.example/article.txt",
        subject_sha256: SUBJECT_SHA,
        proof_bundle_url: "https://proofs.example/bundle.json",
        reason: "paid proof verify",
      };

      const result = await x402Fetch(server.url, requester.account, "POST", JSON.stringify(body));
      expect(result.success).toBe(true);
      const response = result.response as Record<string, unknown>;
      expect(response.status).toBe("ok");
      expect(response.verdict).toBe("valid");
      expect(response.verifier_receipt_sha256).toMatch(/^0x[0-9a-f]{64}$/);
      expect((response.metadata as Record<string, unknown>).provider_backend).toEqual({
        kind: "skills",
        stages: ["proofverify.verify"],
      });
      expect(submittedPayments).toBe(1);
    } finally {
      await server.close();
      db.close();
    }
  });
});
