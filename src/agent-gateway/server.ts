import http, { type IncomingMessage, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { OpenFoxDatabase, OpenFoxIdentity } from "../types.js";
import { createLogger } from "../observability/logger.js";
import type { AgentGatewayServerConfig } from "../types.js";
import { verifyGatewaySessionAuth } from "./auth.js";
import {
  buildGatewayPublicUrl,
  buildGatewaySessionUrl,
  gatewayAgentIdFromIdentity,
  normalizeGatewayPath,
  type AgentGatewayAllocatedEndpoint,
  type AgentGatewayErrorFrame,
  type AgentGatewayFrame,
  type AgentGatewayRelayRequest,
  type AgentGatewayRelayResponse,
  type AgentGatewayRouteRegistration,
  type AgentGatewaySessionOpen,
  type StartedAgentGatewayServer,
} from "./types.js";

const logger = createLogger("agent-gateway.server");
const BODY_LIMIT_FALLBACK = 128 * 1024;

interface LiveSession {
  id: string;
  agentId: string;
  primaryIdentity: string;
  ws: WebSocket;
  routes: Map<string, AgentGatewayRouteRegistration>;
}

interface PendingForward {
  resolve(frame: AgentGatewayRelayResponse | AgentGatewayErrorFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function readNonce(db: OpenFoxDatabase | undefined, key: string): boolean {
  if (!db) return false;
  return Boolean(db.getKV(key));
}

function recordNonce(
  db: OpenFoxDatabase | undefined,
  key: string,
  expiresAt: number,
): void {
  if (!db) return;
  db.setKV(key, JSON.stringify({ expiresAt }));
}

function nonceKey(gatewayAgentId: string, nonce: string): string {
  return `agent_gateway:session_nonce:${gatewayAgentId}:${nonce.toLowerCase()}`;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    res.setHeader(key, value);
  }
  res.end(payload);
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendFrame(ws: WebSocket, frame: AgentGatewayFrame): void {
  ws.send(JSON.stringify(frame));
}

function buildSessionId(): string {
  return randomBytes(8).toString("hex");
}

function parseFrame(raw: unknown): AgentGatewayFrame {
  const payload =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Buffer.from(raw as ArrayBuffer).toString("utf8");
  return JSON.parse(payload) as AgentGatewayFrame;
}

function normalizeForwardHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function applyResponseHeaders(
  res: ServerResponse,
  headers: Record<string, string>,
  body: Buffer,
): void {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection") {
      continue;
    }
    if (lower === "content-length") {
      continue;
    }
    res.setHeader(key, value);
  }
  res.setHeader("Content-Length", body.byteLength);
}

export async function startAgentGatewayServer(params: {
  identity: OpenFoxIdentity;
  db?: OpenFoxDatabase;
  gatewayConfig: AgentGatewayServerConfig;
}): Promise<StartedAgentGatewayServer> {
  const { identity, db, gatewayConfig } = params;
  const gatewayAgentId = gatewayAgentIdFromIdentity(identity);
  const sessions = new Map<string, LiveSession>();
  const pending = new Map<string, PendingForward>();
  const alive = new WeakMap<WebSocket, boolean>();
  let resolvedPublicBaseUrl = gatewayConfig.publicBaseUrl.replace(/\/$/, "");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      const prefix = gatewayConfig.publicPathPrefix.startsWith("/")
        ? gatewayConfig.publicPathPrefix
        : `/${gatewayConfig.publicPathPrefix}`;
      if (req.method === "GET" && url.pathname === `${prefix}/healthz`) {
        json(res, 200, {
          ok: true,
          gatewayAgentId,
          capability: gatewayConfig.capability,
        });
        return;
      }
      if (!url.pathname.startsWith(`${prefix}/`)) {
        json(res, 404, { error: "not found" });
        return;
      }
      const remainder = url.pathname.slice(prefix.length + 1);
      const slashIndex = remainder.indexOf("/");
      if (slashIndex <= 0) {
        json(res, 404, { error: "unknown relay path" });
        return;
      }
      const sessionId = remainder.slice(0, slashIndex);
      const routePath = normalizeGatewayPath(remainder.slice(slashIndex));
      const session = sessions.get(sessionId);
      if (!session) {
        json(res, 503, { error: "provider session unavailable" });
        return;
      }
      const route = session.routes.get(routePath);
      if (!route) {
        json(res, 404, { error: "route not registered" });
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD"
        ? Buffer.alloc(0)
        : await readBody(req, gatewayConfig.maxRequestBodyBytes || BODY_LIMIT_FALLBACK);
      const requestId = buildSessionId();
      const response = await new Promise<
        AgentGatewayRelayResponse | AgentGatewayErrorFrame
      >((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("gateway relay timed out"));
        }, gatewayConfig.requestTimeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        const frame: AgentGatewayRelayRequest = {
          type: "request",
          request_id: requestId,
          method: req.method || "GET",
          path: routePath,
          headers: normalizeForwardHeaders(req.headers),
          body_base64: body.byteLength ? body.toString("base64") : undefined,
        };
        sendFrame(session.ws, frame);
      });
      if (response.type === "error") {
        json(res, 502, { error: response.error });
        return;
      }
      const responseBody = response.body_base64
        ? Buffer.from(response.body_base64, "base64")
        : Buffer.alloc(0);
      res.statusCode = response.status;
      applyResponseHeaders(res, response.headers, responseBody);
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(responseBody);
      }
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const sessionPath = gatewayConfig.sessionPath.startsWith("/")
      ? gatewayConfig.sessionPath
      : `/${gatewayConfig.sessionPath}`;
    if (url.pathname !== sessionPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    let session: LiveSession | null = null;
    ws.on("message", async (raw) => {
      try {
        const frame = parseFrame(raw);
        if (!session) {
          if (frame.type !== "session_open") {
            sendFrame(ws, { type: "error", error: "expected session_open" });
            ws.close();
            return;
          }
          const open = frame as AgentGatewaySessionOpen;
          if (open.routes.length > gatewayConfig.maxRoutesPerSession) {
            sendFrame(ws, { type: "error", error: "too many routes" });
            ws.close();
            return;
          }
          const valid = await verifyGatewaySessionAuth({
            auth: open.auth,
            expectedGatewayAgentId: gatewayAgentId,
          });
          if (!valid) {
            sendFrame(ws, { type: "error", error: "invalid session auth" });
            ws.close();
            return;
          }
          const replayKey = nonceKey(gatewayAgentId, open.auth.session_nonce);
          if (readNonce(db, replayKey)) {
            sendFrame(ws, { type: "error", error: "duplicate session nonce" });
            ws.close();
            return;
          }
          recordNonce(db, replayKey, open.auth.expires_at);

          const routes = new Map<string, AgentGatewayRouteRegistration>();
          for (const route of open.routes) {
            const path = normalizeGatewayPath(route.path);
            if (routes.has(path)) {
              sendFrame(ws, {
                type: "error",
                error: `duplicate route ${path}`,
              });
              ws.close();
              return;
            }
            routes.set(path, { ...route, path });
          }
          const sessionId = buildSessionId();
          session = {
            id: sessionId,
            agentId: open.auth.agent_id.toLowerCase(),
            primaryIdentity: open.auth.primary_identity.value.toLowerCase(),
            ws,
            routes,
          };
          sessions.set(sessionId, session);
          const allocatedEndpoints: AgentGatewayAllocatedEndpoint[] = [
            ...routes.values(),
          ].map((route) => ({
            path: route.path,
            public_url: buildGatewayPublicUrl({
              publicBaseUrl: resolvedPublicBaseUrl,
              publicPathPrefix: gatewayConfig.publicPathPrefix,
              sessionId,
              path: route.path,
            }),
          }));
          sendFrame(ws, {
            type: "session_open_ack",
            session_id: sessionId,
            allocated_endpoints: allocatedEndpoints,
            relay_pricing: {
              mode: gatewayConfig.mode,
              note:
                gatewayConfig.mode === "sponsored"
                  ? "gateway relay available"
                  : gatewayConfig.priceModel,
            },
          });
          logger.info(
            `Gateway session opened for ${session.agentId} with ${routes.size} route(s)`,
          );
          return;
        }

        if (frame.type === "response" || frame.type === "error") {
          const requestId = frame.request_id;
          if (!requestId) {
            return;
          }
          const waiter = pending.get(requestId);
          if (!waiter) {
            return;
          }
          pending.delete(requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(frame as AgentGatewayRelayResponse | AgentGatewayErrorFrame);
        }
      } catch (error) {
        sendFrame(ws, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.on("close", () => {
      if (session) {
        sessions.delete(session.id);
        logger.info(`Gateway session closed for ${session.agentId}`);
      }
    });
  });

  const pingTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (!alive.get(session.ws)) {
        session.ws.terminate();
        sessions.delete(session.id);
        continue;
      }
      alive.set(session.ws, false);
      session.ws.ping();
    }
  }, 15_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(gatewayConfig.port, gatewayConfig.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort =
    addr && typeof addr === "object" && "port" in addr
      ? addr.port
      : gatewayConfig.port;
  const publicBase = new URL(gatewayConfig.publicBaseUrl);
  publicBase.port = String(boundPort);
  resolvedPublicBaseUrl = publicBase.toString().replace(/\/$/, "");
  const sessionUrl = buildGatewaySessionUrl(
    { ...gatewayConfig, publicBaseUrl: resolvedPublicBaseUrl },
    boundPort,
  );

  return {
    gatewayAgentId,
    sessionUrl,
    publicBaseUrl: resolvedPublicBaseUrl,
    close: async () => {
      clearInterval(pingTimer);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("gateway shutting down"));
      }
      pending.clear();
      for (const session of sessions.values()) {
        session.ws.close();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
