import { WebSocket } from "ws";
import type { OpenFoxConfig, OpenFoxDatabase, OpenFoxIdentity } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { discoverCapabilityProviders } from "../agent-discovery/client.js";
import { signGatewaySessionAuth } from "./auth.js";
import {
  normalizeGatewayPath,
  type AgentGatewayAllocatedEndpoint,
  type AgentGatewayErrorFrame,
  type AgentGatewayFrame,
  type AgentGatewayProviderRoute,
  type AgentGatewayRelayRequest,
  type AgentGatewayRelayResponse,
  type AgentGatewaySessionOpen,
  type StartedAgentGatewayProviderSession,
} from "./types.js";

const logger = createLogger("agent-gateway.client");
const BODY_LIMIT_BYTES = 128 * 1024;

async function selectGatewayTarget(params: {
  config: OpenFoxConfig;
  db?: OpenFoxDatabase;
}): Promise<{
  gatewayAgentId: string;
  gatewayUrl: string;
}> {
  const client = params.config.agentDiscovery?.gatewayClient;
  if (client?.gatewayAgentId && client.gatewayUrl) {
    return {
      gatewayAgentId: client.gatewayAgentId.toLowerCase(),
      gatewayUrl: client.gatewayUrl,
    };
  }
  if (params.config.agentDiscovery?.enabled) {
    try {
      const providers = await discoverCapabilityProviders({
        config: params.config,
        capability: "gateway.relay",
        limit: 5,
        db: params.db,
      });
      const gatewayProvider = providers.find(
        (provider) => provider.endpoint.kind === "ws",
      );
      if (gatewayProvider) {
        return {
          gatewayAgentId: gatewayProvider.card.agent_id.toLowerCase(),
          gatewayUrl: gatewayProvider.endpoint.url,
        };
      }
    } catch (error) {
      logger.warn(
        `Gateway discovery failed, falling back to bootnodes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const bootnode = client?.gatewayBootnodes?.[0];
  if (bootnode) {
    return {
      gatewayAgentId: bootnode.agentId.toLowerCase(),
      gatewayUrl: bootnode.url,
    };
  }
  throw new Error("no gateway target configured");
}

function parseFrame(raw: WebSocket.RawData): AgentGatewayFrame {
  const payload = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return JSON.parse(payload) as AgentGatewayFrame;
}

function filterForwardHeaders(
  headers: Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "transfer-encoding" ||
      lower === "content-length"
    ) {
      return;
    }
    out[key] = value;
  });
  return out;
}

async function handleRelayRequest(
  routeMap: Map<string, AgentGatewayProviderRoute>,
  frame: AgentGatewayRelayRequest,
): Promise<AgentGatewayRelayResponse | AgentGatewayErrorFrame> {
  const route = routeMap.get(normalizeGatewayPath(frame.path));
  if (!route) {
    return {
      type: "error",
      request_id: frame.request_id,
      error: `unregistered route ${frame.path}`,
    };
  }
  try {
    const body = frame.body_base64
      ? Buffer.from(frame.body_base64, "base64")
      : undefined;
    if (body && body.byteLength > BODY_LIMIT_BYTES) {
      throw new Error("relayed body exceeds local limit");
    }
    const response = await fetch(route.targetUrl, {
      method: frame.method,
      headers: frame.headers,
      body:
        frame.method === "GET" || frame.method === "HEAD" ? undefined : body,
    });
    const responseBody =
      frame.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    return {
      type: "response",
      request_id: frame.request_id,
      status: response.status,
      headers: filterForwardHeaders(response.headers),
      body_base64: responseBody.byteLength
        ? responseBody.toString("base64")
        : undefined,
    };
  } catch (error) {
    return {
      type: "error",
      request_id: frame.request_id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startAgentGatewayProviderSession(params: {
  identity: OpenFoxIdentity;
  config: OpenFoxConfig;
  tosAddress: string;
  routes: AgentGatewayProviderRoute[];
  db?: OpenFoxDatabase;
}): Promise<StartedAgentGatewayProviderSession> {
  const clientConfig = params.config.agentDiscovery?.gatewayClient;
  if (!clientConfig?.enabled) {
    throw new Error("gateway client is not enabled");
  }
  if (!params.routes.length) {
    throw new Error("no gateway routes configured");
  }

  const { gatewayAgentId, gatewayUrl } = await selectGatewayTarget({
    config: params.config,
    db: params.db,
  });
  const auth = await signGatewaySessionAuth({
    account: params.identity.account,
    agentId: (params.config.agentId || params.identity.address).toLowerCase(),
    primaryIdentity: {
      kind: "tos",
      value: params.tosAddress.toLowerCase(),
    },
    gatewayAgentId,
    ttlSeconds: clientConfig.sessionTtlSeconds,
  });
  const sessionOpen: AgentGatewaySessionOpen = {
    type: "session_open",
    auth,
    routes: params.routes.map((route) => ({
      path: normalizeGatewayPath(route.path),
      capability: route.capability,
      mode: route.mode,
    })),
  };

  const ws = new WebSocket(gatewayUrl);
  const routeMap = new Map(
    params.routes.map((route) => [normalizeGatewayPath(route.path), route]),
  );

  return await new Promise<StartedAgentGatewayProviderSession>((resolve, reject) => {
    let sessionId: string | null = null;
    let settled = false;
    let allocatedEndpoints: AgentGatewayAllocatedEndpoint[] = [];
    const openTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error("gateway session open timed out"));
      }
    }, clientConfig.requestTimeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify(sessionOpen));
    });

    ws.on("message", async (raw) => {
      try {
        const frame = parseFrame(raw);
        if (frame.type === "session_open_ack") {
          sessionId = frame.session_id;
          allocatedEndpoints = frame.allocated_endpoints;
          if (!settled) {
            settled = true;
            clearTimeout(openTimer);
            resolve({
              gatewayAgentId,
              gatewayUrl,
              sessionId,
              allocatedEndpoints,
              close: async () => {
                ws.close();
                await new Promise<void>((resolveClose) => {
                  ws.once("close", () => resolveClose());
                });
              },
            });
          }
          return;
        }
        if (frame.type === "request") {
          const response = await handleRelayRequest(routeMap, frame);
          ws.send(JSON.stringify(response));
          return;
        }
        if (frame.type === "error" && !settled) {
          settled = true;
          clearTimeout(openTimer);
          reject(new Error(frame.error));
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(openTimer);
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          logger.warn(
            `Gateway provider session message handling failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });

    ws.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(openTimer);
        reject(error);
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(openTimer);
        reject(new Error("gateway session closed before ack"));
      } else if (sessionId) {
        logger.warn(`Gateway provider session ${sessionId} closed`);
      }
    });
  });
}
