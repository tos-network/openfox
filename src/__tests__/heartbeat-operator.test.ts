import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCronTask,
  buildCronListReport,
  buildHeartbeatStatusReport,
  disableHeartbeat,
  enableHeartbeat,
  queueManualWake,
  removeCronTask,
} from "../heartbeat/operator.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { createTestDb } from "./mocks.js";
import type { OpenFoxDatabase } from "../types.js";

describe("heartbeat operator", () => {
  let db: OpenFoxDatabase;
  let tempDir: string;
  let heartbeatConfigPath: string;

  beforeEach(() => {
    db = createTestDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-heartbeat-"));
    heartbeatConfigPath = path.join(tempDir, "heartbeat.yml");
    writeDefaultHeartbeatConfig(heartbeatConfigPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds and removes scheduled tasks through config-backed operator helpers", () => {
    addCronTask({
      heartbeatConfigPath,
      db,
      rawDb: db.raw,
      taskName: "report_metrics",
      schedule: "*/5 * * * *",
    });

    const listAfterAdd = buildCronListReport(db.raw);
    expect(listAfterAdd).toContain("report_metrics");
    expect(fs.readFileSync(heartbeatConfigPath, "utf8")).toContain("report_metrics");

    removeCronTask({
      heartbeatConfigPath,
      db,
      rawDb: db.raw,
      taskName: "report_metrics",
    });

    const listAfterRemove = buildCronListReport(db.raw);
    expect(listAfterRemove).not.toContain("report_metrics");
    expect(fs.readFileSync(heartbeatConfigPath, "utf8")).not.toContain("report_metrics");
  });

  it("reports paused state and pending wake reasons", () => {
    disableHeartbeat(db.raw);
    queueManualWake(db.raw, "manual wake for review");

    const report = buildHeartbeatStatusReport(db.raw, {
      entries: [],
      defaultIntervalMs: 60_000,
      lowComputeMultiplier: 4,
    });
    expect(report).toContain("Enabled: no");
    expect(report).toContain("Pending wakes: 1");
    expect(report).toContain("manual wake for review");

    enableHeartbeat(db.raw);
    const enabledReport = buildHeartbeatStatusReport(db.raw, {
      entries: [],
      defaultIntervalMs: 60_000,
      lowComputeMultiplier: 4,
    });
    expect(enabledReport).toContain("Enabled: yes");
  });
});
