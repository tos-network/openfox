import http, { type IncomingMessage, type ServerResponse } from "http";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type {
  OpenFoxConfig,
  OpenFoxDatabase,
  OpenFoxIdentity,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import { resolvePath } from "../config.js";
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
  buildStorageServerUrl,
  type AgentDiscoveryStorageServerConfig,
  type StorageGetInvocationRequest,
  type StorageGetInvocationResponse,
  type StoragePutInvocationRequest,
  type StoragePutInvocationResponse,
} from "./types.js";
import {
  ensureRequestNotReplayed,
  normalizeNonce,
  recordRequestNonce,
  validateRequestExpiry,
} from "./security.js";

const logger = createLogger("agent-discovery.storage");

export interface AgentDiscoveryStorageServer {
  close(): Promise<void>;
  url: string;
}

export interface StartAgentDiscoveryStorageServerParams {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  address: string;
  db: OpenFoxDatabase;
  storageConfig: AgentDiscoveryStorageServerConfig;
}

interface StoredStorageObject {
  objectId: string;
  objectKey?: string;
  contentType: string;
  contentSha256: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
  storedAt: string;
  filePath: string;
}

const BODY_LIMIT_BYTES = 512 * 1024;

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

function buildStorageRequestKey(
  scope: "put" | "get",
  requesterIdentity: string,
  capability: string,
  nonce: string,
): string {
  return [
    "agent_discovery:storage",
    scope,
    requesterIdentity.toLowerCase(),
    capability,
    normalizeNonce(nonce),
  ].join(":");
}

function storageMetaKey(objectId: string): string {
  return `agent_discovery:storage:object:${objectId}`;
}

function buildStorageObjectPath(objectId: string): string {
  return `/storage/object/${objectId}`;
}

function toHexSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseObjectId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

function loadStoredObject(
  db: OpenFoxDatabase,
  objectId: string,
): StoredStorageObject | null {
  const raw = db.getKV(storageMetaKey(objectId));
  if (!raw) return null;
  return JSON.parse(raw) as StoredStorageObject;
}

function storeObject(db: OpenFoxDatabase, object: StoredStorageObject): void {
  db.setKV(storageMetaKey(object.objectId), JSON.stringify(object));
}

function detectContentType(request: StoragePutInvocationRequest): string {
  if (request.content_type?.trim()) return request.content_type.trim();
  if (request.content_text !== undefined) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function decodePutPayload(
  request: StoragePutInvocationRequest,
  maxObjectBytes: number,
): { buffer: Buffer; contentType: string } {
  if (request.content_text === undefined && request.content_base64 === undefined) {
    throw new Error("storage.put requires content_text or content_base64");
  }
  const buffer =
    request.content_base64 !== undefined
      ? Buffer.from(request.content_base64, "base64")
      : Buffer.from(request.content_text || "", "utf8");
  if (buffer.byteLength > maxObjectBytes) {
    throw new Error(`object exceeds maxObjectBytes (${maxObjectBytes})`);
  }
  return {
    buffer,
    contentType: detectContentType(request),
  };
}

function validatePutRequest(
  request: StoragePutInvocationRequest,
  config: AgentDiscoveryStorageServerConfig,
): string {
  if (request.capability !== config.putCapability) {
    throw new Error(`unsupported capability ${request.capability}`);
  }
  if (!request.requester?.identity?.value) {
    throw new Error("missing requester identity");
  }
  validateRequestExpiry(request.request_expires_at);
  normalizeNonce(request.request_nonce);
  return request.requester.identity.value.toLowerCase();
}

function validateGetRequest(
  request: StorageGetInvocationRequest,
  config: AgentDiscoveryStorageServerConfig,
): string {
  if (request.capability !== config.getCapability) {
    throw new Error(`unsupported capability ${request.capability}`);
  }
  if (!request.requester?.identity?.value) {
    throw new Error("missing requester identity");
  }
  validateRequestExpiry(request.request_expires_at);
  normalizeNonce(request.request_nonce);
  if (!request.object_id && !request.content_sha256) {
    throw new Error("storage.get requires object_id or content_sha256");
  }
  return request.requester.identity.value.toLowerCase();
}

async function requirePayment(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: OpenFoxConfig;
  providerAddress: string;
  amountWei: string;
  description: string;
}): Promise<VerifiedTOSPayment | null> {
  const rpcUrl = params.config.rpcUrl || process.env.TOS_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Chain RPC is required to run the storage server");
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
    description: params.description,
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

export async function startAgentDiscoveryStorageServer(
  params: StartAgentDiscoveryStorageServerParams,
): Promise<AgentDiscoveryStorageServer> {
  const { storageConfig, config, db, address } = params;
  const pathPrefix = storageConfig.path.startsWith("/")
    ? storageConfig.path
    : `/${storageConfig.path}`;
  const healthzPath = `${pathPrefix}/healthz`;
  const rootPaths = new Set([pathPrefix, "/storage"]);
  const putPaths = new Set([`${pathPrefix}/put`, "/storage/put", ...rootPaths]);
  const getPaths = new Set([`${pathPrefix}/get`, "/storage/get", ...rootPaths]);
  const objectPrefix = "/storage/object/";
  const rootDir = resolvePath(storageConfig.storageDir);
  const objectsDir = path.join(rootDir, "objects");
  fs.mkdirSync(objectsDir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === healthzPath) {
        json(res, 200, {
          ok: true,
          putCapability: storageConfig.putCapability,
          getCapability: storageConfig.getCapability,
          putPriceWei: storageConfig.putPriceWei,
          getPriceWei: storageConfig.getPriceWei,
          address,
          storageDir: rootDir,
        });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith(objectPrefix)) {
        const objectId = parseObjectId(url.pathname.slice(objectPrefix.length));
        if (!objectId) {
          json(res, 400, { error: "missing object id" });
          return;
        }
        const object = loadStoredObject(db, objectId);
        if (!object) {
          json(res, 404, { error: "object not found" });
          return;
        }
        json(res, 200, {
          object_id: object.objectId,
          result_url: buildStorageObjectPath(object.objectId),
          object_key: object.objectKey || null,
          content_type: object.contentType,
          content_sha256: object.contentSha256,
          size_bytes: object.sizeBytes,
          metadata: object.metadata || {},
          stored_at: object.storedAt,
        });
        return;
      }
      if ((putPaths.has(url.pathname) || getPaths.has(url.pathname)) && req.method === "HEAD") {
        const amountWei = putPaths.has(url.pathname)
          ? storageConfig.putPriceWei
          : storageConfig.getPriceWei;
        const description = putPaths.has(url.pathname)
          ? "OpenFox storage.put payment"
          : "OpenFox storage.get payment";
        const paid = await requirePayment({
          req,
          res,
          config,
          providerAddress: address,
          amountWei,
          description,
        });
        if (paid) {
          res.statusCode = 200;
          res.end();
        }
        return;
      }
      if (req.method === "POST" && (putPaths.has(url.pathname) || getPaths.has(url.pathname))) {
        const rawBody = (await readJsonBody(req)) as Record<string, unknown>;
        const capability = String(rawBody.capability || "").trim();
        const wantsPut =
          url.pathname.endsWith("/put") ||
          (rootPaths.has(url.pathname) && capability === storageConfig.putCapability);
        const wantsGet =
          url.pathname.endsWith("/get") ||
          (rootPaths.has(url.pathname) && capability === storageConfig.getCapability);

        if (wantsPut) {
          const body = rawBody as unknown as StoragePutInvocationRequest;
          const requesterIdentity = validatePutRequest(body, storageConfig);
          const requestKey = buildStorageRequestKey(
            "put",
            requesterIdentity,
            body.capability,
            body.request_nonce,
          );
          const existingObjectId = db.getKV(requestKey);
          if (existingObjectId) {
            const existingObject = loadStoredObject(db, existingObjectId);
            if (!existingObject) {
              json(res, 409, { status: "rejected", reason: "storage.put state is inconsistent" });
              return;
            }
            const response: StoragePutInvocationResponse = {
              status: "ok",
              object_id: existingObject.objectId,
              result_url: buildStorageObjectPath(existingObject.objectId),
              idempotent: true,
              stored_at: Math.floor(new Date(existingObject.storedAt).getTime() / 1000),
              object_key: existingObject.objectKey,
              content_type: existingObject.contentType,
              content_sha256: existingObject.contentSha256,
              size_bytes: existingObject.sizeBytes,
              metadata: existingObject.metadata,
            };
            json(res, 200, response);
            return;
          }

          ensureRequestNotReplayed({
            db,
            scope: "storage_put",
            requesterIdentity,
            capability: body.capability,
            nonce: body.request_nonce,
          });

          const paid = await requirePayment({
            req,
            res,
            config,
            providerAddress: address,
            amountWei: storageConfig.putPriceWei,
            description: "OpenFox storage.put payment",
          });
          if (!paid) {
            return;
          }

          recordRequestNonce({
            db,
            scope: "storage_put",
            requesterIdentity,
            capability: body.capability,
            nonce: body.request_nonce,
            expiresAt: body.request_expires_at,
          });

          const { buffer, contentType } = decodePutPayload(body, storageConfig.maxObjectBytes);
          const hashHex = toHexSha256(buffer);
          const objectId = hashHex;
          const filePath = path.join(objectsDir, `${objectId}.bin`);
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, buffer);
          }
          const storedAt = new Date().toISOString();
          const object: StoredStorageObject = {
            objectId,
            objectKey: body.object_key?.trim() || undefined,
            contentType,
            contentSha256: `0x${hashHex}`,
            sizeBytes: buffer.byteLength,
            metadata: body.metadata,
            storedAt,
            filePath,
          };
          storeObject(db, object);
          db.setKV(requestKey, objectId);
          const response: StoragePutInvocationResponse = {
            status: "ok",
            object_id: objectId,
            result_url: buildStorageObjectPath(objectId),
            payment_tx_hash: paid.txHash,
            stored_at: Math.floor(Date.now() / 1000),
            object_key: object.objectKey,
            content_type: contentType,
            content_sha256: object.contentSha256,
            size_bytes: object.sizeBytes,
            metadata: object.metadata,
          };
          json(res, 200, response);
          return;
        }

        if (wantsGet) {
          const body = rawBody as unknown as StorageGetInvocationRequest;
          const requesterIdentity = validateGetRequest(body, storageConfig);
          const requestKey = buildStorageRequestKey(
            "get",
            requesterIdentity,
            body.capability,
            body.request_nonce,
          );
          const existingGet = db.getKV(requestKey);
          if (existingGet) {
            json(res, 200, JSON.parse(existingGet) as StorageGetInvocationResponse);
            return;
          }

          ensureRequestNotReplayed({
            db,
            scope: "storage_get",
            requesterIdentity,
            capability: body.capability,
            nonce: body.request_nonce,
          });

          const paid = await requirePayment({
            req,
            res,
            config,
            providerAddress: address,
            amountWei: storageConfig.getPriceWei,
            description: "OpenFox storage.get payment",
          });
          if (!paid) {
            return;
          }

          recordRequestNonce({
            db,
            scope: "storage_get",
            requesterIdentity,
            capability: body.capability,
            nonce: body.request_nonce,
            expiresAt: body.request_expires_at,
          });

          const objectId = parseObjectId(body.object_id || body.content_sha256 || "");
          const object = loadStoredObject(db, objectId);
          if (!object) {
            json(res, 404, { status: "rejected", reason: "object not found" });
            return;
          }
          if (body.max_bytes !== undefined && object.sizeBytes > body.max_bytes) {
            json(res, 400, {
              status: "rejected",
              reason: `object exceeds requested max_bytes (${body.max_bytes})`,
            });
            return;
          }
          const buffer = fs.readFileSync(object.filePath);
          const response: StorageGetInvocationResponse = {
            status: "ok",
            payment_tx_hash: paid.txHash,
            fetched_at: Math.floor(Date.now() / 1000),
            object_id: object.objectId,
            content_type: object.contentType,
            content_sha256: object.contentSha256,
            size_bytes: object.sizeBytes,
            metadata: object.metadata,
            ...(body.inline_base64 === false
              ? {}
              : { content_base64: buffer.toString("base64") }),
            ...(object.contentType.startsWith("text/") ||
            object.contentType.includes("json")
              ? { content_text: buffer.toString("utf8") }
              : {}),
          };
          db.setKV(requestKey, JSON.stringify(response));
          json(res, 200, response);
          return;
        }

        throw new Error(`unsupported capability ${capability}`);
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      logger.warn(
        `Storage request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      json(res, 400, {
        status: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(storageConfig.port, storageConfig.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    addr && typeof addr === "object" && "port" in addr ? addr.port : storageConfig.port;
  const actualURL = buildStorageServerUrl({
    ...storageConfig,
    port: boundPort,
  });
  logger.info(`Agent Discovery storage server listening on ${actualURL}`);

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
