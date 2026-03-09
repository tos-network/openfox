import type BetterSqlite3 from "better-sqlite3";
import type { OpenFoxConfig } from "../types.js";
import { verifyGatewayBootnodeList } from "../agent-gateway/bootnodes.js";

type DatabaseType = BetterSqlite3.Database;

interface HealthProbeResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  details?: string;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function buildLocalHttpUrl(host: string, port: number, pathname: string): string {
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `http://${normalizedHost}:${port}${path}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function detectServiceRoles(config: OpenFoxConfig): string[] {
  const roles: string[] = [];
  if (config.agentDiscovery?.enabled) {
    roles.push("requester");
  }
  if (
    config.agentDiscovery?.faucetServer?.enabled ||
    config.agentDiscovery?.observationServer?.enabled ||
    (config.agentDiscovery?.gatewayClient?.enabled &&
      (config.agentDiscovery.gatewayClient.routes?.length ?? 0) > 0)
  ) {
    roles.push("provider");
  }
  if (config.agentDiscovery?.gatewayServer?.enabled) {
    roles.push("gateway");
  }
  return uniqueStrings(roles);
}

function inferProviderRoutes(config: OpenFoxConfig): Array<{
  path: string;
  capability: string;
  mode: string;
  targetUrl: string;
}> {
  const routes = [...(config.agentDiscovery?.gatewayClient?.routes ?? [])];
  const faucet = config.agentDiscovery?.faucetServer;
  if (faucet?.enabled && faucet.port > 0) {
    routes.push({
      path: "/faucet",
      capability: faucet.capability,
      mode: "sponsored",
      targetUrl: buildLocalHttpUrl(faucet.bindHost, faucet.port, faucet.path),
    });
  }
  const observation = config.agentDiscovery?.observationServer;
  if (observation?.enabled && observation.port > 0) {
    routes.push({
      path: "/observe-once",
      capability: observation.capability,
      mode: "paid",
      targetUrl: buildLocalHttpUrl(
        observation.bindHost,
        observation.port,
        observation.path,
      ),
    });
  }
  return routes;
}

function listGatewaySessionCache(rawDb: DatabaseType): Array<{
  key: string;
  value: string;
}> {
  return rawDb
    .prepare(
      "SELECT key, value FROM kv WHERE key LIKE 'agent_gateway:last_session:%' ORDER BY key ASC",
    )
    .all() as Array<{ key: string; value: string }>;
}

function listGatewayServerSessionCache(rawDb: DatabaseType): Array<{
  key: string;
  value: string;
}> {
  return rawDb
    .prepare(
      "SELECT key, value FROM kv WHERE key LIKE 'agent_gateway:server_session:%' ORDER BY key ASC",
    )
    .all() as Array<{ key: string; value: string }>;
}

async function probeHttpJson(url: string): Promise<HealthProbeResult> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.text();
    return {
      name: url,
      url,
      ok: response.ok,
      status: response.status,
      details: body.slice(0, 200),
    };
  } catch (error) {
    return {
      name: url,
      url,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeRpc(rpcUrl: string): Promise<HealthProbeResult> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tos_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.text();
    return {
      name: "rpc",
      url: rpcUrl,
      ok: response.ok && body.includes("\"result\""),
      status: response.status,
      details: body.slice(0, 200),
    };
  } catch (error) {
    return {
      name: "rpc",
      url: rpcUrl,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildServiceStatusReport(
  config: OpenFoxConfig,
  rawDb?: DatabaseType,
): string {
  const roles = detectServiceRoles(config);
  const lines = [
    "=== OPENFOX SERVICES ===",
    `Roles: ${roles.length ? roles.join(", ") : "(none)"}`,
    `Discovery: ${yesNo(config.agentDiscovery?.enabled === true)}`,
    `RPC: ${config.rpcUrl || "(unset)"}${config.chainId ? ` (chain ${config.chainId})` : ""}`,
  ];

  const faucet = config.agentDiscovery?.faucetServer;
  const observation = config.agentDiscovery?.observationServer;
  const gatewayServer = config.agentDiscovery?.gatewayServer;
  const gatewayClient = config.agentDiscovery?.gatewayClient;

  lines.push("", "Provider surfaces:");
  if (faucet?.enabled) {
    lines.push(
      `  - faucet: ${buildLocalHttpUrl(faucet.bindHost, faucet.port, faucet.path)}  capability=${faucet.capability}`,
    );
  }
  if (observation?.enabled) {
    lines.push(
      `  - observation: ${buildLocalHttpUrl(observation.bindHost, observation.port, observation.path)}  capability=${observation.capability}`,
    );
  }
  const routes = inferProviderRoutes(config);
  for (const route of routes) {
    lines.push(
      `  - route: ${route.path} -> ${route.targetUrl}  capability=${route.capability}  mode=${route.mode}`,
    );
  }
  if (!faucet?.enabled && !observation?.enabled && routes.length === 0) {
    lines.push("  (none)");
  }

  lines.push("", "Gateway server:");
  if (gatewayServer?.enabled) {
    const healthz = `${gatewayServer.publicBaseUrl.replace(/\/$/, "")}${gatewayServer.publicPathPrefix.startsWith("/") ? gatewayServer.publicPathPrefix : `/${gatewayServer.publicPathPrefix}`}/healthz`;
    lines.push(`  - public base: ${gatewayServer.publicBaseUrl}`);
    lines.push(
      `  - session url: ${gatewayServer.publicBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}${gatewayServer.sessionPath.startsWith("/") ? gatewayServer.sessionPath : `/${gatewayServer.sessionPath}`}`,
    );
    lines.push(`  - healthz: ${healthz}`);
    lines.push(
      `  - mode=${gatewayServer.mode} payment_direction=${gatewayServer.paymentDirection || "requester_pays"} capability=${gatewayServer.capability}`,
    );
  } else {
    lines.push("  (disabled)");
  }

  lines.push("", "Gateway client:");
  if (gatewayClient?.enabled) {
    lines.push(`  - max sessions: ${gatewayClient.maxGatewaySessions}`);
    lines.push(`  - e2e: ${yesNo(gatewayClient.enableE2E === true)}`);
    lines.push(`  - signed bootnode list required: ${yesNo(gatewayClient.requireSignedBootnodeList === true)}`);
    lines.push(`  - configured bootnodes: ${gatewayClient.gatewayBootnodes.length}`);
    if (gatewayClient.gatewayUrl) {
      lines.push(`  - pinned gateway url: ${gatewayClient.gatewayUrl}`);
    }
  } else {
    lines.push("  (disabled)");
  }

  if (rawDb) {
    const cachedProviderSessions = listGatewaySessionCache(rawDb);
    const cachedServerSessions = listGatewayServerSessionCache(rawDb);
    lines.push("", "Gateway cache:");
    lines.push(`  - provider session cache entries: ${cachedProviderSessions.length}`);
    lines.push(`  - server session cache entries: ${cachedServerSessions.length}`);
  }

  lines.push("========================");
  return lines.join("\n");
}

export async function buildGatewayStatusReport(
  config: OpenFoxConfig,
  rawDb?: DatabaseType,
): Promise<string> {
  const gatewayServer = config.agentDiscovery?.gatewayServer;
  const gatewayClient = config.agentDiscovery?.gatewayClient;
  const lines = ["=== OPENFOX GATEWAY ==="];

  if (gatewayServer?.enabled) {
    lines.push("Server: enabled");
    lines.push(`  capability: ${gatewayServer.capability}`);
    lines.push(`  public base: ${gatewayServer.publicBaseUrl}`);
    lines.push(`  bind: ${gatewayServer.bindHost}:${gatewayServer.port}`);
    lines.push(`  payment direction: ${gatewayServer.paymentDirection || "requester_pays"}`);
    lines.push(`  mode: ${gatewayServer.mode}`);
  } else {
    lines.push("Server: disabled");
  }

  if (gatewayClient?.enabled) {
    lines.push("Client: enabled");
    lines.push(`  max sessions: ${gatewayClient.maxGatewaySessions}`);
    lines.push(`  routes: ${gatewayClient.routes.length}`);
    lines.push(`  e2e: ${yesNo(gatewayClient.enableE2E === true)}`);
    lines.push(`  signed bootnode list required: ${yesNo(gatewayClient.requireSignedBootnodeList === true)}`);
    if (gatewayClient.gatewayUrl) {
      lines.push(`  pinned gateway: ${gatewayClient.gatewayUrl}`);
    }
    if (gatewayClient.gatewayBootnodeList) {
      const valid = await verifyGatewayBootnodeList(gatewayClient.gatewayBootnodeList, config);
      lines.push(`  signed bootnode list: ${valid ? "valid" : "invalid"}`);
      lines.push(`  signed bootnode signer: ${gatewayClient.gatewayBootnodeList.signer}`);
      lines.push(`  signed bootnode entries: ${gatewayClient.gatewayBootnodeList.entries.length}`);
    } else {
      lines.push("  signed bootnode list: (none)");
    }
  } else {
    lines.push("Client: disabled");
  }

  if (rawDb) {
    const cachedProviderSessions = listGatewaySessionCache(rawDb);
    const cachedServerSessions = listGatewayServerSessionCache(rawDb);
    if (cachedProviderSessions.length) {
      lines.push("Provider session cache:");
      for (const entry of cachedProviderSessions) {
        lines.push(`  - ${entry.key}`);
      }
    }
    if (cachedServerSessions.length) {
      lines.push("Server session cache:");
      for (const entry of cachedServerSessions) {
        lines.push(`  - ${entry.key}`);
      }
    }
  }

  lines.push("=======================");
  return lines.join("\n");
}

export async function buildGatewayBootnodesReport(
  config: OpenFoxConfig,
): Promise<string> {
  const gatewayClient = config.agentDiscovery?.gatewayClient;
  const lines = ["=== OPENFOX GATEWAY BOOTNODES ==="];
  if (!gatewayClient?.enabled) {
    lines.push("Gateway client disabled.", "================================");
    return lines.join("\n");
  }

  if (gatewayClient.gatewayBootnodeList) {
    const valid = await verifyGatewayBootnodeList(gatewayClient.gatewayBootnodeList, config);
    lines.push(`Signed list: ${valid ? "valid" : "invalid"}`);
    lines.push(`Signer: ${gatewayClient.gatewayBootnodeList.signer}`);
  } else {
    lines.push("Signed list: (none)");
  }

  const entries = gatewayClient.gatewayBootnodeList?.entries || gatewayClient.gatewayBootnodes;
  if (entries.length === 0) {
    lines.push("(no bootnodes configured)", "================================");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(
      `- ${entry.agentId}  ${entry.url}${entry.payToAddress ? `  pay_to=${entry.payToAddress}` : ""}${entry.paymentDirection ? `  payment=${entry.paymentDirection}` : ""}`,
    );
  }
  lines.push("================================");
  return lines.join("\n");
}

export async function runServiceHealthChecks(
  config: OpenFoxConfig,
): Promise<string> {
  const results: HealthProbeResult[] = [];

  if (config.rpcUrl) {
    results.push(await probeRpc(config.rpcUrl));
  }

  const faucet = config.agentDiscovery?.faucetServer;
  if (faucet?.enabled && faucet.port > 0) {
    const base = buildLocalHttpUrl(faucet.bindHost, faucet.port, faucet.path);
    results.push(await probeHttpJson(`${base}/healthz`));
  }

  const observation = config.agentDiscovery?.observationServer;
  if (observation?.enabled && observation.port > 0) {
    const base = buildLocalHttpUrl(
      observation.bindHost,
      observation.port,
      observation.path,
    );
    results.push(await probeHttpJson(`${base}/healthz`));
  }

  const gatewayServer = config.agentDiscovery?.gatewayServer;
  if (gatewayServer?.enabled) {
    const prefix = gatewayServer.publicPathPrefix.startsWith("/")
      ? gatewayServer.publicPathPrefix
      : `/${gatewayServer.publicPathPrefix}`;
    results.push(
      await probeHttpJson(
        `${gatewayServer.publicBaseUrl.replace(/\/$/, "")}${prefix}/healthz`,
      ),
    );
  }

  const lines = ["=== OPENFOX SERVICE CHECK ==="];
  if (results.length === 0) {
    lines.push("(no checks configured)", "============================");
    return lines.join("\n");
  }

  for (const result of results) {
    lines.push(
      `- ${result.ok ? "OK" : "FAIL"}  ${result.url}${result.status ? `  status=${result.status}` : ""}${result.details ? `  ${result.details}` : ""}`,
    );
  }
  lines.push("============================");
  return lines.join("\n");
}
