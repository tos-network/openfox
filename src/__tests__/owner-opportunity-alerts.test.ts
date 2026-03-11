import { describe, expect, it } from "vitest";
import { DEFAULT_OWNER_REPORTS_CONFIG, type OpportunityItem } from "../types.js";
import { upsertStrategyProfile } from "../opportunity/strategy.js";
import { generateOwnerOpportunityAlerts } from "../reports/alerts.js";
import { createTestConfig, createTestDb } from "./mocks.js";

describe("owner opportunity alerts", () => {
  it("generates and deduplicates unread alerts from ranked opportunities", async () => {
    const db = createTestDb();
    try {
      upsertStrategyProfile(db, {
        profileId: "default",
        name: "default",
        revenueTargetWei: "1000000000000000000",
        maxSpendPerOpportunityWei: "100000000000000000",
        minMarginBps: 500,
        enabledOpportunityKinds: ["bounty", "provider", "campaign"],
        enabledProviderClasses: ["task_market", "observation", "oracle"],
        allowedTrustTiers: ["org_trusted", "public_low_trust", "unknown"],
        automationLevel: "bounded_auto",
        reportCadence: "daily",
        maxDeadlineHours: 168,
      });

      const config = createTestConfig({
        ownerReports: {
          ...DEFAULT_OWNER_REPORTS_CONFIG,
          enabled: true,
          alerts: {
            ...DEFAULT_OWNER_REPORTS_CONFIG.alerts,
            enabled: true,
            minStrategyScore: 1000,
            minMarginBps: 500,
            maxItemsPerRun: 5,
            requireStrategyMatched: true,
            dedupeHours: 24,
          },
        },
      });

      const items: OpportunityItem[] = [
        {
          kind: "bounty",
          providerClass: "task_market",
          trustTier: "org_trusted",
          title: "Translate an earnings summary",
          description: "Submit one bounded translation result.",
          capability: "task.submit",
          baseUrl: "https://host.example.com",
          bountyId: "bounty-1",
          providerAgentId: "agent-host",
          providerAddress:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          grossValueWei: "200000000000000000",
          estimatedCostWei: "10000000000000000",
          marginWei: "190000000000000000",
          marginBps: 9500,
          rawScore: 10,
          strategyScore: 1800,
          strategyMatched: true,
          strategyReasons: [],
        },
      ];

      const first = await generateOwnerOpportunityAlerts({
        config,
        db,
        nowMs: Date.parse("2026-03-11T18:00:00.000Z"),
        items,
      });
      expect(first.created).toBe(1);
      expect(first.skipped).toBe(0);
      expect(db.listOwnerOpportunityAlerts(10).length).toBe(1);

      const second = await generateOwnerOpportunityAlerts({
        config,
        db,
        nowMs: Date.parse("2026-03-11T19:00:00.000Z"),
        items,
      });
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(1);
      expect(db.listOwnerOpportunityAlerts(10).length).toBe(1);
    } finally {
      db.close();
    }
  });
});
