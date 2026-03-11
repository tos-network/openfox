import type { OpenFoxDatabase } from "../types.js";
import type { OracleResolutionResponse } from "./types.js";

export interface StoredOracleJobSummary {
  resultId: string;
  request: {
    query: string;
    query_kind: string;
  };
  response: OracleResolutionResponse;
  createdAt: string;
}

export function listStoredOracleJobs(
  db: OpenFoxDatabase,
  limit = 20,
): StoredOracleJobSummary[] {
  const rows = db.raw
    .prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key DESC LIMIT ?")
    .all("agent_discovery:oracle:job:%", Math.max(1, limit)) as Array<{
      key: string;
      value: string;
    }>;
  return rows.map((row) => JSON.parse(row.value) as StoredOracleJobSummary);
}

export function getStoredOracleJob(
  db: OpenFoxDatabase,
  resultId: string,
): StoredOracleJobSummary | null {
  const raw = db.getKV(`agent_discovery:oracle:job:${resultId}`);
  return raw ? (JSON.parse(raw) as StoredOracleJobSummary) : null;
}

export interface OracleSummarySnapshot {
  totalResults: number;
  queryKinds: Record<string, number>;
  settledResults: number;
  marketBoundResults: number;
  averageConfidence: number;
  estimatedCostWei: string;
  latestResultId: string | null;
  latestResolvedAt: number | null;
  items: StoredOracleJobSummary[];
  summary: string;
}

export function buildOracleSummary(params: {
  db: OpenFoxDatabase;
  limit?: number;
}): OracleSummarySnapshot {
  const items = listStoredOracleJobs(params.db, params.limit ?? 20);
  const queryKinds: Record<string, number> = {};
  let settledResults = 0;
  let marketBoundResults = 0;
  let confidenceTotal = 0;
  let confidenceCount = 0;
  let estimatedCostWei = 0n;

  for (const item of items) {
    queryKinds[item.response.query_kind] = (queryKinds[item.response.query_kind] || 0) + 1;
    if (item.response.settlement_tx_hash) settledResults += 1;
    if (item.response.market_callback_tx_hash || item.response.binding_hash) {
      marketBoundResults += 1;
    }
    if (typeof item.response.confidence === "number" && Number.isFinite(item.response.confidence)) {
      confidenceTotal += item.response.confidence;
      confidenceCount += 1;
    }
    if (item.response.price_wei && /^[0-9]+$/.test(item.response.price_wei)) {
      estimatedCostWei += BigInt(item.response.price_wei);
    }
  }

  const latest = items[0] ?? null;
  return {
    totalResults: items.length,
    queryKinds,
    settledResults,
    marketBoundResults,
    averageConfidence:
      confidenceCount === 0 ? 0 : Number((confidenceTotal / confidenceCount).toFixed(4)),
    estimatedCostWei: estimatedCostWei.toString(),
    latestResultId: latest?.resultId ?? null,
    latestResolvedAt: latest?.response.resolved_at ?? null,
    items,
    summary:
      items.length === 0
        ? "No oracle results recorded."
        : `${items.length} oracle result(s), settled=${settledResults}, market_bound=${marketBoundResults}, avg_confidence=${confidenceCount === 0 ? "0.0000" : (confidenceTotal / confidenceCount).toFixed(4)}.`,
  };
}

export function buildOracleSummaryReport(snapshot: OracleSummarySnapshot): string {
  const lines = [
    "=== OPENFOX ORACLE SUMMARY ===",
    `Results:         ${snapshot.totalResults}`,
    `Settled:         ${snapshot.settledResults}`,
    `Market bound:    ${snapshot.marketBoundResults}`,
    `Avg confidence:  ${snapshot.averageConfidence.toFixed(4)}`,
    `Estimated cost:  ${snapshot.estimatedCostWei} wei`,
    `Latest result:   ${snapshot.latestResultId || "(none)"}`,
    `Latest resolved: ${snapshot.latestResolvedAt ?? "(none)"}`,
    `Kinds:           ${
      Object.keys(snapshot.queryKinds).length === 0
        ? "(none)"
        : Object.entries(snapshot.queryKinds)
            .map(([kind, count]) => `${kind}=${count}`)
            .join(", ")
    }`,
    "",
    `Summary: ${snapshot.summary}`,
  ];
  return lines.join("\n");
}
