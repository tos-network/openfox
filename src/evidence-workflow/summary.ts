import type { OpenFoxDatabase } from "../types.js";
import type { EvidenceWorkflowRunRecord } from "./coordinator.js";

function listEvidenceWorkflowRuns(
  db: OpenFoxDatabase,
  limit = 20,
): EvidenceWorkflowRunRecord[] {
  const rows = db.raw
    .prepare("SELECT value FROM kv WHERE key LIKE ? ORDER BY key DESC LIMIT ?")
    .all("evidence_workflow:index:%", Math.max(1, limit)) as Array<{ value: string }>;
  return rows
    .map((row) => db.getKV(row.value.startsWith("evidence_workflow:run:") ? row.value : `evidence_workflow:run:${row.value}`))
    .filter((raw): raw is string => typeof raw === "string" && raw.length > 0)
    .map((raw) => JSON.parse(raw) as EvidenceWorkflowRunRecord);
}

function sumPriceWei(...values: Array<string | undefined>): bigint {
  return values.reduce((acc, value) => {
    if (!value || !/^[0-9]+$/.test(value)) return acc;
    return acc + BigInt(value);
  }, 0n);
}

export interface EvidenceWorkflowSummarySnapshot {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  validSources: number;
  attemptedSources: number;
  aggregatePublished: number;
  estimatedCostWei: string;
  latestRunId: string | null;
  latestUpdatedAt: string | null;
  runs: EvidenceWorkflowRunRecord[];
  summary: string;
}

export function buildEvidenceWorkflowSummary(params: {
  db: OpenFoxDatabase;
  limit?: number;
}): EvidenceWorkflowSummarySnapshot {
  const runs = listEvidenceWorkflowRuns(params.db, params.limit ?? 20);
  const completedRuns = runs.filter((run) => run.status === "completed").length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;
  const validSources = runs.reduce((acc, run) => acc + run.validCount, 0);
  const attemptedSources = runs.reduce((acc, run) => acc + run.attemptedCount, 0);
  const aggregatePublished = runs.filter(
    (run) => Boolean(run.aggregateObjectId || run.aggregateResultUrl),
  ).length;
  const estimatedCostWei = runs
    .reduce((acc, run) => {
      const sourceCost = run.sourceRecords.reduce((inner, source) => {
        return (
          inner +
          sumPriceWei(source.fetchResponse?.price_wei, source.verifyResponse?.price_wei)
        );
      }, 0n);
      return acc + sourceCost + sumPriceWei(run.aggregateResponse?.price_wei);
    }, 0n)
    .toString();
  const latest = runs[0] ?? null;
  return {
    totalRuns: runs.length,
    completedRuns,
    failedRuns,
    validSources,
    attemptedSources,
    aggregatePublished,
    estimatedCostWei,
    latestRunId: latest?.runId ?? null,
    latestUpdatedAt: latest?.updatedAt ?? null,
    runs,
    summary:
      runs.length === 0
        ? "No evidence workflow runs recorded."
        : `${runs.length} workflow run(s), completed=${completedRuns}, failed=${failedRuns}, valid_sources=${validSources}/${attemptedSources}, aggregate_published=${aggregatePublished}.`,
  };
}

export function buildEvidenceWorkflowSummaryReport(
  snapshot: EvidenceWorkflowSummarySnapshot,
): string {
  const lines = [
    "=== OPENFOX EVIDENCE SUMMARY ===",
    `Runs:            ${snapshot.totalRuns}`,
    `Completed:       ${snapshot.completedRuns}`,
    `Failed:          ${snapshot.failedRuns}`,
    `Valid sources:   ${snapshot.validSources}/${snapshot.attemptedSources}`,
    `Aggregates:      ${snapshot.aggregatePublished}`,
    `Estimated cost:  ${snapshot.estimatedCostWei} wei`,
    `Latest run:      ${snapshot.latestRunId || "(none)"}`,
    `Latest updated:  ${snapshot.latestUpdatedAt || "(none)"}`,
    "",
    `Summary: ${snapshot.summary}`,
  ];
  return lines.join("\n");
}

