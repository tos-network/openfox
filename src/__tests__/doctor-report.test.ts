import { describe, expect, it } from "vitest";
import { createTestConfig, createTestDb } from "./mocks.js";
import {
  buildDoctorReport,
  buildHealthSnapshotReport,
} from "../doctor/report.js";

describe("doctor report formatting", () => {
  it("renders health and doctor reports from a synthetic snapshot", () => {
    const db = createTestDb();
    const config = createTestConfig({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 1666,
    });

    const snapshot = {
      configPath: "/tmp/openfox.json",
      walletPath: "/tmp/wallet.json",
      configPresent: true,
      walletPresent: true,
      inferenceConfigured: true,
      rpcConfigured: true,
      discoveryEnabled: true,
      gatewayEnabled: false,
      providerEnabled: false,
      managedService: {
        manager: "systemd-user" as const,
        available: true,
        installed: false,
        enabled: null,
        active: null,
        unitName: "openfox.service",
        unitPath: "/tmp/openfox.service",
        workingDirectory: "/tmp/openfox",
        entryPath: "/tmp/openfox/dist/index.js",
        details: "service unit not installed",
      },
      heartbeatPaused: false,
      pendingWakes: 0,
      skillCount: 1,
      ineligibleEnabledSkills: ["test-skill"],
      serviceStatusReport: "service status report",
      gatewayStatusReport: "gateway status report",
      serviceHealthReport: "OK rpc http://127.0.0.1:8545",
      findings: [
        {
          id: "service-not-installed",
          severity: "warn" as const,
          summary: "OpenFox is not installed as a managed service.",
          recommendation: "Run `openfox service install`.",
        },
        {
          id: "skills-warning",
          severity: "warn" as const,
          summary: "Enabled skills are missing requirements: test-skill",
        },
        {
          id: "rpc-ok",
          severity: "ok" as const,
          summary: "Chain RPC probe succeeded.",
        },
      ],
    };

    const health = buildHealthSnapshotReport(snapshot);
    const doctor = buildDoctorReport(snapshot);

    expect(health).toContain("=== OPENFOX HEALTH ===");
    expect(health).toContain("service status report");
    expect(doctor).toContain("=== OPENFOX DOCTOR ===");
    expect(doctor).toContain("Warnings: 2");
    expect(doctor).toContain("Run `openfox service install`.");

    db.close();
    void config;
  });
});
