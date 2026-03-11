import fs from "fs";
import path from "path";
import {
  buildFleetLintSnapshot,
  buildFleetSnapshot,
  loadFleetManifest,
  type FleetEndpoint,
  type FleetSnapshot,
} from "./fleet.js";

export const DEFAULT_DASHBOARD_ENDPOINTS: FleetEndpoint[] = [
  "status",
  "health",
  "service",
  "gateway",
  "storage",
  "lease-health",
  "artifacts",
  "signer",
  "paymaster",
  "providers",
];

export interface FleetDashboardSnapshot {
  generatedAt: string;
  manifestPath: string;
  nodeCount: number;
  roles: Record<string, number>;
  endpointSummaries: Array<{
    endpoint: FleetEndpoint;
    total: number;
    ok: number;
    failed: number;
  }>;
  failingEndpoints: FleetEndpoint[];
  snapshots: Record<FleetEndpoint, FleetSnapshot>;
}

export interface FleetDashboardBundleResult {
  outputPath: string;
  manifestCopyPath: string;
  lintPath: string;
  jsonPath: string;
  htmlPath: string;
  snapshot: FleetDashboardSnapshot;
}

function summarizeRoles(manifestPath: string): {
  nodeCount: number;
  roles: Record<string, number>;
} {
  const manifest = loadFleetManifest(manifestPath);
  const roles: Record<string, number> = {};
  for (const node of manifest.nodes) {
    const role = node.role || "unspecified";
    roles[role] = (roles[role] || 0) + 1;
  }
  return {
    nodeCount: manifest.nodes.length,
    roles,
  };
}

function summaryString(snapshot: FleetSnapshot): string {
  return `${snapshot.ok}/${snapshot.total} healthy`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if (
    "summary" in payload &&
    typeof (payload as { summary?: unknown }).summary === "string"
  ) {
    return (payload as { summary: string }).summary;
  }
  return JSON.stringify(payload);
}

export async function buildFleetDashboardSnapshot(params: {
  manifestPath: string;
  endpoints?: FleetEndpoint[];
}): Promise<FleetDashboardSnapshot> {
  const manifestPath = path.resolve(params.manifestPath);
  const endpoints = params.endpoints ?? DEFAULT_DASHBOARD_ENDPOINTS;
  const roleSummary = summarizeRoles(manifestPath);
  const snapshotEntries = await Promise.all(
    endpoints.map(async (endpoint) => {
      const snapshot = await buildFleetSnapshot({
        manifestPath,
        endpoint,
      });
      return [endpoint, snapshot] as const;
    }),
  );
  const snapshots = Object.fromEntries(snapshotEntries) as Record<
    FleetEndpoint,
    FleetSnapshot
  >;
  const endpointSummaries = endpoints.map((endpoint) => ({
    endpoint,
    total: snapshots[endpoint].total,
    ok: snapshots[endpoint].ok,
    failed: snapshots[endpoint].failed,
  }));
  return {
    generatedAt: new Date().toISOString(),
    manifestPath,
    nodeCount: roleSummary.nodeCount,
    roles: roleSummary.roles,
    endpointSummaries,
    failingEndpoints: endpointSummaries
      .filter((entry) => entry.failed > 0)
      .map((entry) => entry.endpoint),
    snapshots,
  };
}

export function buildFleetDashboardReport(
  snapshot: FleetDashboardSnapshot,
): string {
  const lines = [
    "=== OPENFOX DASHBOARD ===",
    `Generated: ${snapshot.generatedAt}`,
    `Manifest:  ${snapshot.manifestPath}`,
    `Nodes:     ${snapshot.nodeCount}`,
    `Roles:     ${Object.entries(snapshot.roles)
      .map(([role, count]) => `${role}=${count}`)
      .join(", ")}`,
    "",
    "Endpoint Summary:",
  ];
  for (const entry of snapshot.endpointSummaries) {
    lines.push(
      `- ${entry.endpoint}: ${entry.ok}/${entry.total} healthy${
        entry.failed ? `, failed=${entry.failed}` : ""
      }`,
    );
  }
  if (snapshot.failingEndpoints.length) {
    lines.push("");
    lines.push(`Failing endpoints: ${snapshot.failingEndpoints.join(", ")}`);
  }
  return lines.join("\n");
}

export function buildFleetDashboardHtml(
  snapshot: FleetDashboardSnapshot,
): string {
  const roleRows = Object.entries(snapshot.roles)
    .map(
      ([role, count]) =>
        `<tr><td>${escapeHtml(role)}</td><td>${count}</td></tr>`,
    )
    .join("");
  const endpointRows = snapshot.endpointSummaries
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.endpoint)}</td><td>${entry.ok}</td><td>${entry.failed}</td><td>${entry.total}</td></tr>`,
    )
    .join("");
  const sections = DEFAULT_DASHBOARD_ENDPOINTS.map((endpoint) => {
    const section = snapshot.snapshots[endpoint];
    if (!section) return "";
    const rows = section.nodes
      .map((node) => {
        const summary = payloadSummary(node.payload);
        return `<tr>
  <td>${escapeHtml(node.name)}</td>
  <td>${escapeHtml(node.role || "")}</td>
  <td>${node.ok ? "ok" : "failed"}</td>
  <td>${escapeHtml(node.baseUrl)}</td>
  <td>${escapeHtml(summary || node.error || "")}</td>
</tr>`;
      })
      .join("");
    return `<section>
  <h2>${escapeHtml(endpoint)} (${escapeHtml(summaryString(section))})</h2>
  <table>
    <thead><tr><th>Node</th><th>Role</th><th>Status</th><th>Base URL</th><th>Summary</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenFox Fleet Dashboard</title>
  <style>
    body { font-family: sans-serif; margin: 24px; color: #111; }
    h1, h2 { margin-bottom: 8px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
    thead { background: #f5f5f5; }
    .meta { margin-bottom: 16px; color: #444; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; }
  </style>
</head>
<body>
  <h1>OpenFox Fleet Dashboard</h1>
  <div class="meta">
    <div><strong>Generated:</strong> ${escapeHtml(snapshot.generatedAt)}</div>
    <div><strong>Manifest:</strong> ${escapeHtml(snapshot.manifestPath)}</div>
    <div><strong>Nodes:</strong> ${snapshot.nodeCount}</div>
    <div><strong>Failing endpoints:</strong> ${escapeHtml(snapshot.failingEndpoints.join(", ") || "none")}</div>
  </div>
  <div class="grid">
    <section>
      <h2>Roles</h2>
      <table>
        <thead><tr><th>Role</th><th>Count</th></tr></thead>
        <tbody>${roleRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Endpoint Summary</h2>
      <table>
        <thead><tr><th>Endpoint</th><th>Healthy</th><th>Failed</th><th>Total</th></tr></thead>
        <tbody>${endpointRows}</tbody>
      </table>
    </section>
  </div>
  ${sections}
</body>
</html>`;
}

export async function exportFleetDashboard(params: {
  manifestPath: string;
  outputPath: string;
  format: "json" | "html";
}): Promise<FleetDashboardSnapshot> {
  const snapshot = await buildFleetDashboardSnapshot({
    manifestPath: params.manifestPath,
  });
  const outputPath = path.resolve(params.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content =
    params.format === "html"
      ? buildFleetDashboardHtml(snapshot)
      : JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(outputPath, content, "utf8");
  return snapshot;
}

export async function exportFleetDashboardBundle(params: {
  manifestPath: string;
  outputPath: string;
  force?: boolean;
}): Promise<FleetDashboardBundleResult> {
  const manifestPath = path.resolve(params.manifestPath);
  const outputPath = path.resolve(params.outputPath);
  if (fs.existsSync(outputPath)) {
    if (!params.force) {
      throw new Error(
        `Output path already exists: ${outputPath}. Re-run with --force to overwrite.`,
      );
    }
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
  fs.mkdirSync(outputPath, { recursive: true });

  const manifestCopyPath = path.join(outputPath, path.basename(manifestPath));
  fs.copyFileSync(manifestPath, manifestCopyPath);

  const snapshot = await buildFleetDashboardSnapshot({ manifestPath });
  const lint = buildFleetLintSnapshot({ manifestPath });
  const jsonPath = path.join(outputPath, "dashboard.json");
  const htmlPath = path.join(outputPath, "dashboard.html");
  const lintPath = path.join(outputPath, "fleet-lint.json");

  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(htmlPath, buildFleetDashboardHtml(snapshot), "utf8");
  fs.writeFileSync(lintPath, JSON.stringify(lint, null, 2), "utf8");

  return {
    outputPath,
    manifestCopyPath,
    lintPath,
    jsonPath,
    htmlPath,
    snapshot,
  };
}
