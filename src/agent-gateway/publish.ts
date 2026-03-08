import type { AgentDiscoveryConfig, OpenFoxConfig } from "../types.js";
import type { StartedAgentGatewayServer, StartedAgentGatewayProviderSession, AgentGatewayProviderRoute } from "./types.js";

function endpointKindFromUrl(url: string): "http" | "https" | "ws" {
  if (url.startsWith("https://")) return "https";
  if (url.startsWith("ws://") || url.startsWith("wss://")) return "ws";
  return "http";
}

function uniqueByName<T>(
  entries: T[],
  keyFn: (entry: T) => string,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function buildGatewayProviderRoutes(params: {
  config: OpenFoxConfig;
  faucetUrl?: string;
  observationUrl?: string;
}): AgentGatewayProviderRoute[] {
  const routes: AgentGatewayProviderRoute[] = [
    ...(params.config.agentDiscovery?.gatewayClient?.routes ?? []),
  ];
  const faucet = params.config.agentDiscovery?.faucetServer;
  if (
    faucet?.enabled &&
    params.faucetUrl &&
    !routes.some((entry) => entry.capability === faucet.capability)
  ) {
    routes.push({
      path: "/faucet",
      capability: faucet.capability,
      mode: "sponsored",
      targetUrl: params.faucetUrl,
    });
  }
  const observation = params.config.agentDiscovery?.observationServer;
  if (
    observation?.enabled &&
    params.observationUrl &&
    !routes.some((entry) => entry.capability === observation.capability)
  ) {
    routes.push({
      path: "/observe-once",
      capability: observation.capability,
      mode: "paid",
      targetUrl: params.observationUrl,
    });
  }
  return uniqueByName(routes, (entry) => `${entry.path}:${entry.capability}`);
}

export function buildPublishedAgentDiscoveryConfig(params: {
  baseConfig: AgentDiscoveryConfig;
  gatewayServer?: StartedAgentGatewayServer;
  gatewayServerConfig?: NonNullable<OpenFoxConfig["agentDiscovery"]>["gatewayServer"];
  providerSession?: StartedAgentGatewayProviderSession;
  providerRoutes?: AgentGatewayProviderRoute[];
}): AgentDiscoveryConfig {
  const endpoints = [...params.baseConfig.endpoints];
  const capabilities = [...params.baseConfig.capabilities];
  const hiddenLocalTargets = new Set(
    (params.providerRoutes ?? []).map((route) => route.targetUrl),
  );

  const publishedEndpoints = endpoints.filter(
    (entry) => !hiddenLocalTargets.has(entry.url),
  );

  if (params.providerSession && params.providerRoutes?.length) {
    for (const allocation of params.providerSession.allocatedEndpoints) {
      publishedEndpoints.push({
        kind: endpointKindFromUrl(allocation.public_url),
        url: allocation.public_url,
        viaGateway: params.providerSession.gatewayAgentId,
      });
    }
  }

  if (params.gatewayServer && params.gatewayServerConfig?.enabled) {
    if (
      !capabilities.some(
        (entry) => entry.name === params.gatewayServerConfig?.capability,
      )
    ) {
      capabilities.push({
        name: params.gatewayServerConfig.capability,
        mode: params.gatewayServerConfig.mode,
        priceModel: params.gatewayServerConfig.priceModel,
        description: "Agent Gateway relay capability",
      });
    }
    publishedEndpoints.push({
      kind: "ws",
      url: params.gatewayServer.sessionUrl,
    });
  }

  return {
    ...params.baseConfig,
    endpoints: uniqueByName(
      publishedEndpoints,
      (entry) => `${entry.kind}:${entry.url}:${entry.viaGateway || ""}`,
    ),
    capabilities: uniqueByName(
      capabilities,
      (entry) => entry.name.toLowerCase(),
    ),
    faucetServer: params.baseConfig.faucetServer
      ? {
          ...params.baseConfig.faucetServer,
          enabled: false,
        }
      : undefined,
    observationServer: params.baseConfig.observationServer
      ? {
          ...params.baseConfig.observationServer,
          enabled: false,
        }
      : undefined,
  };
}
