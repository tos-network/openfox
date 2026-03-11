import http, { type IncomingMessage, type ServerResponse } from "http";
import { createHash } from "crypto";
import { URL } from "url";
import type {
  OpenFoxConfig,
  OpenFoxDatabase,
  OpenFoxIdentity,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import {
  TOSRpcClient as RpcClient,
  formatTOSNetwork as formatNetwork,
} from "../tos/client.js";
import {
  readTOSPaymentEnvelope,
  submitTOSPayment,
  verifyTOSPayment,
  writeTOSPaymentRequired,
  type TOSPaymentRequirement,
  type VerifiedTOSPayment,
} from "../tos/x402.js";
import { normalizeTOSAddress as normalizeAddress } from "../tos/address.js";
import {
  buildNewsFetchServerUrl,
  type AgentDiscoveryNewsFetchServerConfig,
  type NewsFetchInvocationRequest,
  type NewsFetchInvocationResponse,
} from "./types.js";
import {
  ensureRequestNotReplayed,
  normalizeNonce,
  recordRequestNonce,
  validateRequestExpiry,
} from "./security.js";

const logger = createLogger("agent-discovery.news-fetch");

export interface AgentDiscoveryNewsFetchServer {
  close(): Promise<void>;
  url: string;
}

export interface StartAgentDiscoveryNewsFetchServerParams {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  address: string;
  db: OpenFoxDatabase;
  newsFetchConfig: AgentDiscoveryNewsFetchServerConfig;
}

interface StoredNewsFetchJob {
  jobId: string;
  requestKey: string;
  request: NewsFetchInvocationRequest;
  response: NewsFetchInvocationResponse;
  requesterIdentity: string;
  capability: string;
  createdAt: string;
}

const BODY_LIMIT_BYTES = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > BODY_LIMIT_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function buildNewsFetchJobId(request: NewsFetchInvocationRequest): string {
  return createHash("sha256")
    .update(
      `${request.requester.identity.value.toLowerCase()}|${request.capability}|${normalizeNonce(request.request_nonce)}`,
    )
    .digest("hex");
}

function buildNewsFetchRequestKey(request: NewsFetchInvocationRequest): string {
  return [
    "agent_discovery:news_fetch:request",
    request.requester.identity.value.toLowerCase(),
    request.capability,
    normalizeNonce(request.request_nonce),
  ].join(":");
}

function getNewsFetchJobKey(jobId: string): string {
  return `agent_discovery:news_fetch:job:${jobId}`;
}

function buildNewsFetchResultPath(jobId: string): string {
  return `/news/fetch/result/${jobId}`;
}

function loadStoredNewsFetchJob(
  db: OpenFoxDatabase,
  jobId: string,
): StoredNewsFetchJob | null {
  const raw = db.getKV(getNewsFetchJobKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw) as StoredNewsFetchJob;
}

function storeNewsFetchJob(db: OpenFoxDatabase, job: StoredNewsFetchJob): void {
  db.setKV(getNewsFetchJobKey(job.jobId), JSON.stringify(job));
  db.setKV(job.requestKey, job.jobId);
}

function validateRequest(
  request: NewsFetchInvocationRequest,
  config: AgentDiscoveryNewsFetchServerConfig,
): { requesterIdentity: string; sourceUrl: URL } {
  if (request.capability !== config.capability) {
    throw new Error(`unsupported capability ${request.capability}`);
  }
  if (!request.requester?.identity?.value) {
    throw new Error("missing requester identity");
  }
  validateRequestExpiry(request.request_expires_at);
  normalizeNonce(request.request_nonce);
  if (!request.source_url || request.source_url.length > config.maxSourceUrlChars) {
    throw new Error(`source_url exceeds maxSourceUrlChars (${config.maxSourceUrlChars})`);
  }
  const sourceUrl = new URL(request.source_url);
  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
    throw new Error("source_url must use http or https");
  }
  return {
    requesterIdentity: request.requester.identity.value.toLowerCase(),
    sourceUrl,
  };
}

async function requirePayment(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: OpenFoxConfig;
  providerAddress: string;
  amountWei: string;
}): Promise<VerifiedTOSPayment | null> {
  const rpcUrl = params.config.rpcUrl || process.env.TOS_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Chain RPC is required to run the news.fetch server");
  }
  const client = new RpcClient({ rpcUrl });
  const chainId = params.config.chainId ? BigInt(params.config.chainId) : await client.getChainId();
  const requirement: TOSPaymentRequirement = {
    scheme: "exact",
    network: formatNetwork(chainId),
    maxAmountRequired: params.amountWei,
    payToAddress: normalizeAddress(params.providerAddress),
    asset: "native",
    requiredDeadlineSeconds: 300,
    description: "OpenFox news.fetch payment",
  };
  const envelope = readTOSPaymentEnvelope(params.req);
  if (!envelope) {
    writeTOSPaymentRequired(params.res, requirement);
    return null;
  }
  const verified = verifyTOSPayment(requirement, envelope);
  await submitTOSPayment(rpcUrl, verified);
  return verified;
}

export async function startAgentDiscoveryNewsFetchServer(
  params: StartAgentDiscoveryNewsFetchServerParams,
): Promise<AgentDiscoveryNewsFetchServer> {
  const { newsFetchConfig, config, db, address } = params;
  const path = newsFetchConfig.path.startsWith("/")
    ? newsFetchConfig.path
    : `/${newsFetchConfig.path}`;
  const healthzPath = `${path}/healthz`;
  const resultPathPrefix = "/news/fetch/result/";
  const requestPaths = new Set([path, "/news/fetch"]);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === healthzPath) {
        json(res, 200, {
          ok: true,
          capability: newsFetchConfig.capability,
          priceWei: newsFetchConfig.priceWei,
          address,
          integration: "skeleton",
        });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith(resultPathPrefix)) {
        const jobId = url.pathname.slice(resultPathPrefix.length).trim();
        if (!jobId) {
          json(res, 400, { error: "missing job id" });
          return;
        }
        const job = loadStoredNewsFetchJob(db, jobId);
        if (!job) {
          json(res, 404, { error: "job not found" });
          return;
        }
        json(res, 200, job.response);
        return;
      }
      if (requestPaths.has(url.pathname) && req.method === "HEAD") {
        const paid = await requirePayment({
          req,
          res,
          config,
          providerAddress: address,
          amountWei: newsFetchConfig.priceWei,
        });
        if (paid) {
          res.statusCode = 200;
          res.end();
        }
        return;
      }
      if (req.method !== "POST" || !requestPaths.has(url.pathname)) {
        json(res, 404, { error: "not found" });
        return;
      }

      const body = (await readJsonBody(req)) as NewsFetchInvocationRequest;
      const { requesterIdentity, sourceUrl } = validateRequest(body, newsFetchConfig);
      const requestKey = buildNewsFetchRequestKey(body);
      const existingJobId = db.getKV(requestKey);
      if (existingJobId) {
        const existingJob = loadStoredNewsFetchJob(db, existingJobId);
        if (!existingJob) {
          json(res, 409, { status: "rejected", reason: "news.fetch job state is inconsistent" });
          return;
        }
        if (existingJob.request.source_url !== body.source_url) {
          json(res, 409, {
            status: "rejected",
            reason: "request nonce is already bound to a different news.fetch payload",
          });
          return;
        }
        json(res, 200, { ...existingJob.response, idempotent: true });
        return;
      }

      ensureRequestNotReplayed({
        db,
        scope: "news_fetch",
        requesterIdentity,
        capability: body.capability,
        nonce: body.request_nonce,
      });

      const paid = await requirePayment({
        req,
        res,
        config,
        providerAddress: address,
        amountWei: newsFetchConfig.priceWei,
      });
      if (!paid) {
        return;
      }

      recordRequestNonce({
        db,
        scope: "news_fetch",
        requesterIdentity,
        capability: body.capability,
        nonce: body.request_nonce,
        expiresAt: body.request_expires_at,
      });

      const jobId = buildNewsFetchJobId(body);
      const response: NewsFetchInvocationResponse = {
        status: "integration_required",
        job_id: jobId,
        result_url: buildNewsFetchResultPath(jobId),
        payment_tx_hash: paid.txHash,
        fetched_at: Math.floor(Date.now() / 1000),
        source_url: sourceUrl.toString(),
        integration_message:
          "news.fetch skeleton is enabled, but no zkTLS capture backend is wired yet.",
        zktls_bundle_format: "draft",
        metadata: {
          publisher_hint: body.publisher_hint || null,
          headline_hint: body.headline_hint || null,
        },
      };
      storeNewsFetchJob(db, {
        jobId,
        requestKey,
        request: body,
        response,
        requesterIdentity,
        capability: body.capability,
        createdAt: new Date().toISOString(),
      });
      json(res, 200, response);
    } catch (error) {
      logger.warn(
        `News fetch request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      json(res, 400, {
        status: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(newsFetchConfig.port, newsFetchConfig.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    addr && typeof addr === "object" && "port" in addr ? addr.port : newsFetchConfig.port;
  const actualURL = buildNewsFetchServerUrl({
    ...newsFetchConfig,
    port: boundPort,
  });
  logger.info(`Agent Discovery news.fetch server listening on ${actualURL}`);

  return {
    url: actualURL,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
