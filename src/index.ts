#!/usr/bin/env node
/**
 * OpenFox Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getOpenFoxDir, loadWalletAccount } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createRuntimeClient } from "./runtime/client.js";
import { createInferenceClient } from "./runtime/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
  syncHeartbeatScheduleToDb,
} from "./heartbeat/config.js";
import {
  consumeNextWakeEvent,
  insertWakeEvent,
} from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { buildSkillStatusReport } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type {
  OpenFoxIdentity,
  AgentState,
  Skill,
  SocialClientInterface,
  PaymasterAuthorizationRecord,
  PaymasterQuoteRecord,
} from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import {
  clearLocalAgentDiscoveryCard,
  discoverCapabilityProviders,
  publishLocalAgentDiscoveryCard,
} from "./agent-discovery/client.js";
import { startAgentDiscoveryFaucetServer } from "./agent-discovery/faucet-server.js";
import { startAgentDiscoveryNewsFetchServer } from "./agent-discovery/news-fetch-server.js";
import { startAgentDiscoveryObservationServer } from "./agent-discovery/observation-server.js";
import { startAgentDiscoveryOracleServer } from "./agent-discovery/oracle-server.js";
import { startAgentDiscoveryProofVerifyServer } from "./agent-discovery/proof-verify-server.js";
import { startAgentDiscoverySentimentAnalysisServer } from "./agent-discovery/sentiment-analysis-server.js";
import { startAgentDiscoveryStorageServer } from "./agent-discovery/storage-server.js";
import { normalizeAgentDiscoveryConfig } from "./agent-discovery/types.js";
import { startAgentGatewayServer } from "./agent-gateway/server.js";
import { startAgentGatewayProviderSessions } from "./agent-gateway/client.js";
import {
  buildGatewayProviderRoutes,
  buildPublishedAgentDiscoveryConfig,
} from "./agent-gateway/publish.js";
import {
  deriveAddressFromPrivateKey,
  normalizeAddress,
} from "./chain/address.js";
import {
  grantCapability,
  registerCapabilityName,
} from "./chain/client.js";
import {
  installSkillFromGit,
  installSkillFromUrl,
} from "./skills/registry.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "tosdk";
import path from "path";
import {
  addCronTask,
  buildCronListSnapshot,
  buildCronRunsSnapshot,
  buildCronTaskSnapshot,
  buildCronListReport,
  buildCronRunsReport,
  buildCronTaskReport,
  buildHeartbeatStatusSnapshot,
  buildHeartbeatStatusReport,
  disableHeartbeat,
  editCronTask,
  enableHeartbeat,
  getBuiltinHeartbeatTasks,
  queueManualWake,
  removeCronTask,
  setCronTaskEnabled,
} from "./heartbeat/operator.js";
import {
  buildCombinedServiceStatusSnapshot,
  buildGatewayBootnodesSnapshot,
  buildGatewayStatusSnapshot,
  buildGatewayBootnodesReport,
  buildGatewayStatusReport,
  buildServiceHealthSnapshot,
  buildServiceStatusReport,
  runServiceHealthChecks,
} from "./service/operator.js";
import {
  buildManagedServiceStatusReport,
  getManagedServiceStatus,
  installManagedService,
  restartManagedService,
  startManagedService,
  stopManagedService,
  uninstallManagedService,
} from "./service/daemon.js";
import { buildServiceLogsReport } from "./service/logs.js";
import {
  buildDoctorReport,
  buildHealthSnapshot,
  buildHealthSnapshotReport,
} from "./doctor/report.js";
import { buildModelStatusReport, buildModelStatusSnapshot } from "./models/status.js";
import { runOnboard } from "./commands/onboard.js";
import { runWalletCommand } from "./commands/wallet.js";
import { handleFleetCommand } from "./commands/fleet.js";
import { handleReportCommand } from "./commands/report.js";
import { handleBountyCommand } from "./commands/bounty.js";
import { handleStorageCommand } from "./commands/storage.js";
import { handleArtifactCommand } from "./commands/artifacts.js";
import { handleCommitteeCommand } from "./commands/committee.js";
import { handleGroupCommand } from "./commands/group.js";
import { handleHeartbeatCommand } from "./commands/heartbeat.js";
import { handleCronCommand } from "./commands/cron.js";
import { handleServiceCommand } from "./commands/service.js";
import { handleGatewayCommand } from "./commands/gateway.js";
import { handleAutopilotCommand } from "./commands/autopilot.js";
import { handleDashboardCommand } from "./commands/dashboard.js";
import { handleHealthCommand, handleDoctorCommand, handleModelsCommand } from "./commands/health.js";
import { handleFinanceCommand } from "./commands/finance.js";
import { handleSettlementCommand } from "./commands/settlement.js";
import { handleMarketCommand } from "./commands/market.js";
import { handlePaymentsCommand } from "./commands/payments.js";
import { handleScoutCommand } from "./commands/scout.js";
import { handleStrategyCommand } from "./commands/strategy.js";
import { handleProvidersCommand } from "./commands/providers.js";
import { handleEvidenceCommand } from "./commands/evidence.js";
import { handleOracleCommand } from "./commands/oracle.js";
import { handleNewsCommand } from "./commands/news.js";
import { handleProofCommand } from "./commands/proof.js";
import { handleTrailsCommand } from "./commands/trails.js";
import { handleSignerCommand } from "./commands/signer.js";
import { handlePaymasterCommand } from "./commands/paymaster.js";
import { showStatus } from "./commands/status.js";
import { handleCampaignCommand } from "./commands/campaign.js";
import { handleLogsCommand } from "./commands/logs.js";
import { run } from "./runtime/run.js";
import { sleep } from "./runtime/agent-loop.js";
import {
  exportBundledTemplate,
  listBundledTemplates,
  readBundledTemplateReadme,
} from "./commands/templates.js";
import {
  exportBundledPack,
  lintBundledPack,
  listBundledPacks,
  readBundledPackReadme,
} from "./commands/packs.js";
import { createBountyEngine } from "./bounty/engine.js";
import { startBountyHttpServer } from "./bounty/http.js";
import { createNativeBountyPayoutSender } from "./bounty/payout.js";
import { startBountyAutomation } from "./bounty/automation.js";
import {
  fetchRemoteCampaign,
  fetchRemoteCampaigns,
  fetchRemoteBounties,
  fetchRemoteBounty,
  solveRemoteBounty,
  submitRemoteBountySubmission,
} from "./bounty/client.js";
import {
  buildOpportunityReport,
  buildRankedOpportunityReport,
  collectOpportunityItems,
  rankOpportunityItems,
} from "./opportunity/scout.js";
import {
  getCurrentStrategyProfile,
  upsertStrategyProfile,
  validateStrategyProfile,
} from "./opportunity/strategy.js";
import { createNativeSettlementPublisher } from "./settlement/publisher.js";
import { createNativeSettlementCallbackDispatcher } from "./settlement/callbacks.js";
import { createMarketBindingPublisher } from "./market/publisher.js";
import { createMarketContractDispatcher } from "./market/contracts.js";
import { createX402PaymentManager } from "./chain/x402-server.js";
import { startStorageProviderServer } from "./storage/http.js";
import {
  auditStoredBundle,
  getStorageHead,
  getStoredBundle,
  renewStoredLease,
  requestStorageQuote,
  storeBundleWithProvider,
} from "./storage/client.js";
import {
  createTrackedStorageLeaseRecord,
  createTrackedStorageRenewalRecord,
  replicateTrackedLease,
} from "./storage/lifecycle.js";
import { createArtifactManager } from "./artifacts/manager.js";
import { createNativeArtifactAnchorPublisher } from "./artifacts/publisher.js";
import { startArtifactCaptureServer } from "./artifacts/server.js";
import { createEvidenceWorkflowCoordinator } from "./evidence-workflow/coordinator.js";
import {
  buildEvidenceWorkflowSummary,
  buildEvidenceWorkflowSummaryReport,
} from "./evidence-workflow/summary.js";
import {
  buildZkTlsBundleSummary,
  buildZkTlsBundleSummaryReport,
  buildProofVerificationSummary,
  buildProofVerificationSummaryReport,
  getZkTlsBundleRecord,
  getProofVerificationRecord,
  listZkTlsBundleRecords,
  listProofVerificationRecords,
} from "./proof-market/records.js";
import {
  buildCommitteeSummaryReport,
  createCommitteeManager,
} from "./committee/manager.js";
import { startSignerProviderServer } from "./signer/http.js";
import {
  fetchSignerExecutionReceipt,
  fetchSignerExecutionStatus,
  fetchSignerQuote,
  submitSignerExecution,
} from "./signer/client.js";
import { startPaymasterProviderServer } from "./paymaster/http.js";
import {
  authorizePaymasterExecution,
  fetchPaymasterAuthorizationReceipt,
  fetchPaymasterAuthorizationStatus,
  fetchPaymasterQuote,
} from "./paymaster/client.js";
import type { SignerProviderTrustTier } from "./types.js";
import type { VerifiedAgentProvider } from "./agent-discovery/types.js";
import {
  readOption,
  readNumberOption,
  collectRepeatedOption,
  readCsvOption,
  readFlag,
  readGroupIdArg,
  readGroupVisibilityOption,
  readGroupJoinModeOption,
  parseGroupChannelSpecs,
  readSignerTrustTierOption,
  resolveSignerProviderBaseUrl,
  resolvePaymasterProviderBaseUrl,
} from "./cli/parse.js";
import {
  NoopInferenceClient,
  createConfiguredInferenceClient,
  hasConfiguredInferenceProvider,
  hasConfiguredInference,
  resolveBountySkillName,
} from "./runtime/inference-factory.js";
import {
  withHeartbeatContext,
  runHeartbeatTaskNow,
} from "./runtime/heartbeat-context.js";
import {
  toPaymasterQuoteRecord,
  toPaymasterAuthorizationRecord,
} from "./runtime/record-transformers.js";
import { hashSignerPolicy } from "./signer/policy.js";
import { hashPaymasterPolicy } from "./paymaster/policy.js";
import fs from "fs/promises";
import { startOperatorApiServer } from "./operator/api.js";
import {
  buildRuntimeStatusReport,
  buildRuntimeStatusSnapshot,
} from "./operator/status.js";
import {
  buildOperatorAutopilotReport,
  buildOperatorAutopilotSnapshot,
  decideOperatorApprovalRequest,
  createOperatorApprovalRequest,
  runOperatorAutopilot,
} from "./operator/autopilot.js";
import {
  buildFleetBundleReport,
  buildFleetBundleSnapshot,
  buildFleetControlReport,
  buildFleetControlSnapshot,
  buildFleetReport,
  buildFleetLintReport,
  buildFleetLintSnapshot,
  buildFleetQueueRetryReport,
  buildFleetQueueRetrySnapshot,
  buildFleetRepairReport,
  buildFleetRepairSnapshot,
  buildFleetReconciliationReport,
  buildFleetReconciliationSnapshot,
  buildFleetProviderLivenessReport,
  buildFleetProviderLivenessSnapshot,
  buildFleetRecoveryReport,
  buildFleetRecoverySnapshot,
  buildFleetSnapshot,
  type FleetControlAction,
  type FleetRepairComponent,
  type FleetEndpoint,
  type FleetRetryQueue,
  type FleetRecoveryKind,
} from "./operator/fleet.js";
import {
  appendFleetIncidentHistory,
  buildFleetIncidentAlertReport,
  buildFleetIncidentRemediationReport,
  buildFleetIncidentReport,
  buildFleetIncidentSnapshot,
  deliverFleetIncidentAlerts,
  evaluateFleetIncidentAlerts,
  readFleetIncidentHistory,
  runFleetIncidentRemediation,
} from "./operator/incidents.js";
import {
  buildFleetDashboardReport,
  buildFleetDashboardSnapshot,
  exportFleetDashboardBundle,
  exportFleetDashboard,
} from "./operator/dashboard.js";
import {
  buildOperatorFinanceReport,
  buildOperatorFinanceSnapshot,
} from "./operator/wallet-finance.js";
import {
  deliverOwnerReportChannels,
} from "./reports/delivery.js";
import {
  buildOwnerReportInput,
  generateOwnerReport,
} from "./reports/generation.js";
import {
  generateOwnerOpportunityAlerts,
  queueOwnerOpportunityAlertAction,
} from "./reports/alerts.js";
import {
  materializeApprovedOwnerOpportunityAction,
} from "./reports/actions.js";
import {
  executeOwnerOpportunityAction,
} from "./reports/action-execution.js";
import {
  renderOwnerReportText,
} from "./reports/render.js";
import {
  startOwnerReportServer,
} from "./reports/server.js";
import {
  runArtifactMaintenance,
  runStorageMaintenance,
} from "./operator/maintenance.js";
import {
  buildProviderReputationSnapshot,
  type ProviderReputationKind,
} from "./operator/provider-reputation.js";
import { buildStorageLeaseHealthSnapshot } from "./operator/storage-health.js";
import {
  buildOracleSummary,
  buildOracleSummaryReport,
  getStoredOracleJob,
  listStoredOracleJobs,
} from "./agent-discovery/oracle-summary.js";
import {
  buildWorldFeedSnapshot,
} from "./metaworld/feed.js";
import {
  buildWorldBoardSnapshot,
  type WorldBoardKind,
} from "./metaworld/boards.js";
import {
  buildWorldFoxDirectorySnapshot,
  buildWorldGroupDirectorySnapshot,
} from "./metaworld/directory.js";
import {
  buildFoxProfile,
} from "./metaworld/profile.js";
import {
  buildFoxPageSnapshot,
  buildFoxPageHtml,
} from "./metaworld/fox-page.js";
import {
  buildGroupPageSnapshot,
  buildGroupPageHtml,
} from "./metaworld/group-page.js";
import {
  buildWorldPresenceSnapshot,
  publishWorldPresence,
  type WorldPresenceStatus,
} from "./metaworld/presence.js";
import {
  buildWorldNotificationsSnapshot,
  dismissWorldNotification,
  markWorldNotificationRead,
} from "./metaworld/notifications.js";
import {
  buildMetaWorldShellHtml,
  buildMetaWorldShellSnapshot,
} from "./metaworld/shell.js";
import {
  exportMetaWorldSite,
} from "./metaworld/site.js";
import {
  acceptGroupInvite,
  approveGroupJoinRequest,
  banGroupMember,
  createGroup,
  createGroupChannel,
  editGroupMessage,
  getGroupDetail,
  leaveGroup,
  listGroupAnnouncements,
  listGroupChannels,
  listGroupEvents,
  listGroupJoinRequests,
  listGroupMessages,
  listGroupMembers,
  listGroups,
  listGroupProposals,
  muteGroupMember,
  postGroupAnnouncement,
  postGroupMessage,
  reactGroupMessage,
  redactGroupMessage,
  removeGroupMember,
  requestToJoinGroup,
  sendGroupInvite,
  type GroupVisibility,
  type GroupJoinMode,
  unbanGroupMember,
  unmuteGroupMember,
  withdrawGroupJoinRequest,
} from "./group/store.js";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`OpenFox v${VERSION}`);
    process.exit(0);
  }

  if (args[0] === "skills") {
    await handleSkillsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "heartbeat") {
    await handleHeartbeatCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "cron") {
    await handleCronCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "service") {
    await handleServiceCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "gateway") {
    await handleGatewayCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "health") {
    await handleHealthCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "doctor") {
    await handleDoctorCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "models") {
    await handleModelsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "onboard") {
    await handleOnboardCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "wallet") {
    await runWalletCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "finance") {
    await handleFinanceCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "report") {
    await handleReportCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "templates") {
    await handleTemplatesCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "packs") {
    await handlePacksCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "logs") {
    await handleLogsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "campaign") {
    await handleCampaignCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "bounty") {
    await handleBountyCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "settlement") {
    await handleSettlementCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "market") {
    await handleMarketCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "payments") {
    await handlePaymentsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "scout") {
    await handleScoutCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "strategy") {
    await handleStrategyCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "storage") {
    await handleStorageCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "providers") {
    await handleProvidersCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "artifacts") {
    await handleArtifactCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "evidence") {
    await handleEvidenceCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "oracle") {
    await handleOracleCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "news") {
    await handleNewsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "proof") {
    await handleProofCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "committee") {
    await handleCommitteeCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "trails") {
    await handleTrailsCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "group") {
    await handleGroupCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "world") {
    await handleWorldCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "signer") {
    await handleSignerCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "paymaster") {
    await handlePaymasterCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "fleet") {
    await handleFleetCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "autopilot") {
    await handleAutopilotCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "dashboard") {
    await handleDashboardCommand(args.slice(1));
    process.exit(0);
  }

  if (args[0] === "status") {
    await showStatus({ asJson: args.includes("--json") });
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
OpenFox v${VERSION}
Sovereign AI Agent Runtime

Usage:
  openfox --run          Start the openfox (first run triggers setup wizard)
  openfox --setup        Re-run the interactive setup wizard
  openfox --configure    Edit configuration (providers, model, treasury, general)
  openfox --pick-model   Interactively pick the active inference model
  openfox --init         Initialize wallet and config directory
  openfox --status       Show current openfox status
  openfox skills ...     Inspect and manage skills
  openfox heartbeat ...  Inspect and control the heartbeat runtime
  openfox cron ...       Inspect and manage scheduled heartbeat tasks
  openfox service ...    Inspect service roles, health, and lifecycle
  openfox gateway ...    Inspect gateway configuration and bootnodes
  openfox health         Show a runtime health snapshot
  openfox doctor         Diagnose runtime/operator issues and next steps
  openfox models ...     Inspect model/provider readiness
  openfox onboard        Run setup and optionally install the managed service
  openfox wallet ...     Inspect, fund, and bootstrap the native wallet
  openfox finance ...    Inspect operator finance snapshots
  openfox report ...     Generate, inspect, and deliver owner reports
  openfox templates ...  Inspect and export bundled third-party templates
  openfox packs ...      Inspect and export bundled control-plane packs
  openfox logs           Show recent OpenFox service logs
  openfox campaign ...   Create and inspect sponsor-facing task campaigns
  openfox bounty ...     Open, inspect, and solve task bounties
  openfox settlement ... Inspect on-chain settlement receipts and anchors
  openfox market ...     Inspect contract-native market bindings and callbacks
  openfox payments ...   Inspect and recover server-side x402 payments
  openfox scout ...      Discover earning opportunities and task surfaces
  openfox strategy ...   Define and validate bounded earning strategy profiles
  openfox storage ...    Use the OpenFox storage market
  openfox providers ...  Inspect provider reputation snapshots
  openfox artifacts ...  Build and verify public news and oracle bundles
  openfox evidence ...   Run coordinator-side M-of-N evidence workflows
  openfox oracle ...     Inspect paid oracle results and summaries
  openfox news ...       Inspect zkTLS-backed news capture bundle records
  openfox proof ...      Inspect proof verification records and summaries
  openfox committee ...  Inspect and manage M-of-N committee workflows
  openfox signer ...     Use delegated signer-provider execution
  openfox paymaster ...  Use native sponsored execution through a paymaster-provider
  openfox group ...      Create and inspect local Fox communities
  openfox world ...      Inspect the local metaWorld activity feed
  openfox fleet ...      Inspect multiple OpenFox nodes through operator APIs
  openfox autopilot ...  Inspect and control bounded operator automation
  openfox dashboard ...  Build fleet dashboard snapshots and exports
  openfox status         Show the current runtime status
  openfox --version      Show version
  openfox --help         Show this help

Environment:
  OPENAI_API_KEY           OpenAI API key
  ANTHROPIC_API_KEY        Anthropic API key
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
  OPENFOX_API_URL           Legacy Runtime API URL (optional)
  OPENFOX_API_KEY           Legacy Runtime API key (optional)
  TOS_RPC_URL              Chain RPC URL (overrides config for native wallet operations)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { privateKey, isNew } = await getWallet();
    const address = deriveAddressFromPrivateKey(privateKey);
    logger.info(
      JSON.stringify({
        address,
        isNew,
        configDir: getOpenFoxDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus({ asJson: args.includes("--json") });
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "openfox --help" for usage information.');
  logger.info('Run "openfox --run" to start the openfox.');
}

async function handleSkillsCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    logger.info(`
OpenFox skills

Usage:
  openfox skills list
  openfox skills status [name]
  openfox skills enable <name>
  openfox skills disable <name>
  openfox skills install --name <name> --git <repo-url>
  openfox skills install --name <name> --url <skill-md-url>
`);
    return;
  }

  const config = loadConfig();
  if (!config) {
    logger.error("OpenFox is not configured. Run openfox --setup first.");
    process.exit(1);
  }

  const db = createDatabase(resolvePath(config.dbPath));
  const skillsDir = config.skillsDir || "~/.openfox/skills";
  const command = args[0] || "list";

  try {
    if (command === "list") {
      const report = buildSkillStatusReport(skillsDir, db);
      if (report.length === 0) {
        logger.info("No skills found.");
        return;
      }
      logger.info("=== OPENFOX SKILLS ===");
      for (const entry of report) {
        const state = entry.enabled ? "enabled" : "disabled";
        const eligibility = entry.eligible ? "eligible" : "missing requirements";
        logger.info(
          `${entry.name}  [${entry.source}]  ${state}  ${eligibility}${entry.always ? "  always" : ""}`,
        );
        if (entry.description) {
          logger.info(`  ${entry.description}`);
        }
      }
      return;
    }

    if (command === "status") {
      const targetName = args[1]?.trim();
      const report = buildSkillStatusReport(skillsDir, db);
      const entries = targetName
        ? report.filter((entry) => entry.name === targetName)
        : report;
      if (entries.length === 0) {
        logger.error(targetName ? `Skill not found: ${targetName}` : "No skills found.");
        process.exit(1);
      }
      for (const entry of entries) {
        logger.info(`
=== SKILL STATUS ===
Name:        ${entry.name}
Source:      ${entry.source}
Enabled:     ${entry.enabled ? "yes" : "no"}
Eligible:    ${entry.eligible ? "yes" : "no"}
Always:      ${entry.always ? "yes" : "no"}
Path:        ${entry.path}
Homepage:    ${entry.homepage || "(none)"}
Primary env: ${entry.primaryEnv || "(none)"}
Missing bins: ${entry.missingBins.length > 0 ? entry.missingBins.join(", ") : "(none)"}
Missing any-bins set: ${entry.missingAnyBins.length > 0 ? entry.missingAnyBins.join(", ") : "(none)"}
Missing env: ${entry.missingEnv.length > 0 ? entry.missingEnv.join(", ") : "(none)"}
Install hints: ${entry.install.length > 0 ? entry.install.map((spec) => spec.label || spec.kind).join(", ") : "(none)"}
Description: ${entry.description || "(none)"}
=====================
`);
      }
      return;
    }

    if (command === "enable" || command === "disable") {
      const name = args[1]?.trim();
      if (!name) {
        logger.error(`Usage: openfox skills ${command} <name>`);
        process.exit(1);
      }
      const skill = db.getSkillByName(name);
      if (!skill) {
        logger.error(`Skill not found: ${name}`);
        process.exit(1);
      }
      db.setSkillEnabled(name, command === "enable");
      logger.info(`Skill ${command}d: ${name}`);
      return;
    }

    if (command === "install") {
      const name = readOption(args, "--name");
      const gitUrl = readOption(args, "--git");
      const url = readOption(args, "--url");

      if (!name || (!gitUrl && !url) || (gitUrl && url)) {
        logger.error("Usage: openfox skills install --name <name> (--git <repo-url> | --url <skill-md-url>)");
        process.exit(1);
      }

      const runtime = createRuntimeClient({
        apiUrl: config.runtimeApiUrl,
        apiKey: config.runtimeApiKey || loadApiKeyFromConfig() || "",
        sandboxId: config.sandboxId,
      });

      const installed = gitUrl
        ? await installSkillFromGit(gitUrl, name, skillsDir, db, runtime)
        : await installSkillFromUrl(url!, name, skillsDir, db, runtime);

      if (!installed) {
        logger.error("Skill installation failed.");
        process.exit(1);
      }
      logger.info(`Skill installed: ${installed.name} (${installed.source})`);
      return;
    }

    logger.error(`Unknown skills command: ${command}`);
    logger.info(`Available commands: list, status, install, enable, disable`);
    process.exit(1);
  } finally {
    db.close();
  }
}



async function handleOnboardCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    logger.info(`
OpenFox onboard

Usage:
  openfox onboard
  openfox onboard --install-daemon
  openfox onboard --force-setup
  openfox onboard --fund-local
  openfox onboard --fund-testnet
  openfox onboard --fund-testnet --faucet-url https://...
  openfox onboard --fund-local --wait
`);
    return;
  }

  const result = await runOnboard({
    installDaemon: args.includes("--install-daemon"),
    forceSetup: args.includes("--force-setup"),
    fundLocal: args.includes("--fund-local"),
    fundTestnet: args.includes("--fund-testnet"),
    waitForFundingReceipt: args.includes("--wait"),
    faucetUrl: readFlag(args, "--faucet-url"),
    fundingReason: readFlag(args, "--reason"),
  });

  logger.info(
    result.daemonInstalled
      ? result.fundingPerformed
        ? "OpenFox onboarding complete. Wallet funded and managed service installed."
        : "OpenFox onboarding complete. Managed service installed."
      : result.fundingPerformed
        ? "OpenFox onboarding complete. Wallet funding requested."
        : "OpenFox onboarding complete.",
  );
}

async function handleTemplatesCommand(args: string[]): Promise<void> {
  const command = args[0] || "list";
  const asJson = args.includes("--json");
  if (args.includes("--help") || args.includes("-h") || command === "help") {
    logger.info(`
OpenFox templates

Usage:
  openfox templates list [--json]
  openfox templates show <name>
  openfox templates export <name> --output <path> [--force] [--json]
`);
    return;
  }

  if (command === "list") {
    const items = listBundledTemplates();
    if (asJson) {
      logger.info(JSON.stringify({ items }, null, 2));
      return;
    }
    if (items.length === 0) {
      logger.info("No bundled templates found.");
      return;
    }
    logger.info("=== OPENFOX TEMPLATES ===");
    for (const item of items) {
      logger.info(`${item.name}`);
      if (item.description) {
        logger.info(`  ${item.description}`);
      }
    }
    return;
  }

  if (command === "show") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: openfox templates show <name>");
    }
    logger.info(readBundledTemplateReadme(name));
    return;
  }

  if (command === "export") {
    const name = args[1];
    const outputPath = readOption(args, "--output");
    if (!name || !outputPath) {
      throw new Error("Usage: openfox templates export <name> --output <path> [--force] [--json]");
    }
    const result = exportBundledTemplate({
      name,
      outputPath,
      force: args.includes("--force"),
    });
    if (asJson) {
      logger.info(JSON.stringify(result, null, 2));
      return;
    }
    logger.info(
      [
        "Template exported.",
        `Name: ${result.name}`,
        `Source: ${result.sourcePath}`,
        `Output: ${result.outputPath}`,
      ].join("\n"),
    );
    return;
  }

  throw new Error(`Unknown templates command: ${command}`);
}

async function handlePacksCommand(args: string[]): Promise<void> {
  const command = args[0] || "list";
  const asJson = args.includes("--json");
  if (args.includes("--help") || args.includes("-h") || command === "help") {
    logger.info(`
OpenFox packs

Usage:
  openfox packs list [--json]
  openfox packs show <name>
  openfox packs export <name> --output <path> [--force] [--json]
  openfox packs lint --path <dir> [--json]
`);
    return;
  }

  if (command === "list") {
    const items = listBundledPacks();
    if (asJson) {
      logger.info(JSON.stringify({ items }, null, 2));
      return;
    }
    if (items.length === 0) {
      logger.info("No bundled packs found.");
      return;
    }
    logger.info("=== OPENFOX PACKS ===");
    for (const item of items) {
      logger.info(`${item.name}${item.version ? `  v${item.version}` : ""}`);
      if (item.description) logger.info(`  ${item.description}`);
    }
    return;
  }

  if (command === "show") {
    const name = args[1];
    if (!name) throw new Error("Usage: openfox packs show <name>");
    logger.info(readBundledPackReadme(name));
    return;
  }

  if (command === "export") {
    const name = args[1];
    const outputPath = readOption(args, "--output");
    if (!name || !outputPath) {
      throw new Error("Usage: openfox packs export <name> --output <path> [--force] [--json]");
    }
    const result = exportBundledPack({
      name,
      outputPath,
      force: args.includes("--force"),
    });
    if (asJson) {
      logger.info(JSON.stringify(result, null, 2));
      return;
    }
    logger.info(
      ["Pack exported.", `Name: ${result.name}`, `Source: ${result.sourcePath}`, `Output: ${result.outputPath}`].join("\n"),
    );
    return;
  }

  if (command === "lint") {
    const packPath = readOption(args, "--path");
    if (!packPath) {
      throw new Error("Usage: openfox packs lint --path <dir> [--json]");
    }
    const result = lintBundledPack(packPath);
    if (asJson) {
      logger.info(JSON.stringify(result, null, 2));
      return;
    }
    logger.info(
      [
        "=== OPENFOX PACK LINT ===",
        `Root: ${result.rootPath}`,
        `Manifest: ${result.manifestPath || "(missing)"}`,
        `Errors: ${result.errors.length}`,
        `Warnings: ${result.warnings.length}`,
        ...result.errors.map((value) => `ERROR: ${value}`),
        ...result.warnings.map((value) => `WARN: ${value}`),
      ].join("\n"),
    );
    return;
  }

  throw new Error(`Unknown packs command: ${command}`);
}

async function handleWorldCommand(args: string[]): Promise<void> {
  const command = args[0] || "feed";
  const asJson = args.includes("--json");
  if (args.includes("--help") || args.includes("-h") || command === "help") {
    logger.info(`
OpenFox world

Usage:
  openfox world feed [--group <group-id>] [--limit N] [--json]
  openfox world board list --kind <work|opportunity|artifact|settlement> [--limit N] [--json]
  openfox world directory foxes [--query <text>] [--role <role>] [--limit N] [--json]
  openfox world directory groups [--query <text>] [--visibility <private|listed|public>] [--tag <tag>] [--role <role>] [--limit N] [--json]
  openfox world fox profile [--address <addr>] [--activity-limit N] [--json]
  openfox world fox page [--address <addr>] [--activity-limit N] [--messages N] [--announcements N] [--presence N] [--json]
  openfox world fox page export --output <path> [--address <addr>] [--activity-limit N] [--messages N] [--announcements N] [--presence N] [--json]
  openfox world group page --group <group-id> [--messages N] [--announcements N] [--events N] [--presence N] [--json]
  openfox world group page export --group <group-id> --output <path> [--messages N] [--announcements N] [--events N] [--presence N] [--json]
  openfox world shell [--feed N] [--notifications N] [--boards N] [--directory N] [--groups N] [--json]
  openfox world shell export --output <path> [--feed N] [--notifications N] [--boards N] [--directory N] [--groups N] [--json]
  openfox world site export --output-dir <path> [--foxes N] [--groups N] [--json]
  openfox world presence publish [--group <group-id>] [--status <online|busy|away|recently_active>] [--ttl-seconds N] [--summary "<text>"] [--json]
  openfox world presence list [--group <group-id>] [--status <all|online|busy|away|recently_active|expired>] [--include-expired] [--limit N] [--json]
  openfox world notifications [--group <group-id>] [--status <all|unread>] [--include-dismissed] [--limit N] [--json]
  openfox world notification read --id <notification-id> [--json]
  openfox world notification dismiss --id <notification-id> [--json]
`);
    return;
  }

  const config = loadConfig();
  if (!config) {
    throw new Error("OpenFox is not configured. Run openfox --setup first.");
  }

  const db = createDatabase(resolvePath(config.dbPath));
  try {
    if (command === "feed") {
      const snapshot = buildWorldFeedSnapshot(db, {
        groupId: readOption(args, "--group"),
        limit: readNumberOption(args, "--limit", 25),
      });
      if (asJson) {
        logger.info(JSON.stringify(snapshot, null, 2));
        return;
      }
      logger.info("=== OPENFOX WORLD FEED ===");
      logger.info(snapshot.summary);
      for (const item of snapshot.items) {
        const groupLabel = item.groupName ? ` [${item.groupName}]` : "";
        logger.info(`${item.occurredAt}  ${item.kind}${groupLabel}`);
        logger.info(`  ${item.title}`);
        logger.info(`  ${item.summary}`);
      }
      return;
    }

    if (command === "notifications") {
      const status = readOption(args, "--status") || "all";
      if (status !== "all" && status !== "unread") {
        throw new Error("Invalid --status value: expected all or unread");
      }
      const snapshot = buildWorldNotificationsSnapshot(db, {
        actorAddress: config.walletAddress,
        groupId: readOption(args, "--group"),
        limit: readNumberOption(args, "--limit", 25),
        unreadOnly: status === "unread",
        includeDismissed: args.includes("--include-dismissed"),
      });
      if (asJson) {
        logger.info(JSON.stringify(snapshot, null, 2));
        return;
      }
      logger.info("=== OPENFOX WORLD NOTIFICATIONS ===");
      logger.info(snapshot.summary);
      for (const item of snapshot.items) {
        const stateLabel = item.dismissedAt
          ? "dismissed"
          : item.readAt
            ? "read"
            : "unread";
        const groupLabel = item.groupName ? ` [${item.groupName}]` : "";
        logger.info(`${item.occurredAt}  ${stateLabel}  ${item.kind}${groupLabel}`);
        logger.info(`  ${item.title}`);
        logger.info(`  ${item.summary}`);
        logger.info(`  ${item.notificationId}`);
      }
      return;
    }

    if (command === "board") {
      const subcommand = args[1] || "list";
      if (subcommand !== "list") {
        throw new Error(`Unknown world board command: ${subcommand}`);
      }
      const kind = readOption(args, "--kind") as WorldBoardKind | undefined;
      if (
        kind !== "work" &&
        kind !== "opportunity" &&
        kind !== "artifact" &&
        kind !== "settlement"
      ) {
        throw new Error(
          "Usage: openfox world board list --kind <work|opportunity|artifact|settlement>",
        );
      }
      const snapshot = buildWorldBoardSnapshot(db, {
        boardKind: kind,
        limit: readNumberOption(args, "--limit", 25),
      });
      if (asJson) {
        logger.info(JSON.stringify(snapshot, null, 2));
        return;
      }
      logger.info(`=== OPENFOX ${kind.toUpperCase()} BOARD ===`);
      logger.info(snapshot.summary);
      for (const item of snapshot.items) {
        logger.info(`${item.occurredAt}  ${item.status}`);
        logger.info(`  ${item.title}`);
        logger.info(`  ${item.summary}`);
      }
      return;
    }

    if (command === "directory") {
      const subcommand = args[1] || "groups";
      if (subcommand === "foxes") {
        const snapshot = buildWorldFoxDirectorySnapshot(db, config, {
          query: readOption(args, "--query"),
          role: readOption(args, "--role"),
          limit: readNumberOption(args, "--limit", 25),
        });
        if (asJson) {
          logger.info(JSON.stringify(snapshot, null, 2));
          return;
        }
        logger.info("=== OPENFOX FOX DIRECTORY ===");
        logger.info(snapshot.summary);
        for (const item of snapshot.items) {
          const presence = item.presenceStatus ? ` ${item.presenceStatus}` : "";
          logger.info(`${item.displayName}${presence}`);
          logger.info(`  ${item.address}`);
          logger.info(
            `  groups=${item.activeGroupCount} roles=${item.roles.join(", ") || "none"}`,
          );
        }
        return;
      }
      if (subcommand === "groups") {
        const visibility = readOption(args, "--visibility") as
          | "private"
          | "listed"
          | "public"
          | undefined;
        if (
          visibility &&
          visibility !== "private" &&
          visibility !== "listed" &&
          visibility !== "public"
        ) {
          throw new Error(
            "Invalid --visibility value: expected private, listed, or public",
          );
        }
        const snapshot = buildWorldGroupDirectorySnapshot(db, {
          query: readOption(args, "--query"),
          visibility,
          tag: readOption(args, "--tag"),
          role: readOption(args, "--role"),
          limit: readNumberOption(args, "--limit", 25),
        });
        if (asJson) {
          logger.info(JSON.stringify(snapshot, null, 2));
          return;
        }
        logger.info("=== OPENFOX GROUP DIRECTORY ===");
        logger.info(snapshot.summary);
        for (const item of snapshot.items) {
          logger.info(`${item.name}  [${item.visibility}]`);
          logger.info(
            `  members=${item.activeMemberCount} join=${item.joinMode} tags=${item.tags.join(", ") || "none"}`,
          );
        }
        return;
      }
      throw new Error(`Unknown world directory command: ${subcommand}`);
    }

    if (command === "fox") {
      const subcommand = args[1] || "profile";
      if (subcommand === "profile") {
        const profile = buildFoxProfile({
          db,
          config,
          address: readOption(args, "--address"),
          activityLimit: readNumberOption(args, "--activity-limit", 10),
        });
        if (asJson) {
          logger.info(JSON.stringify(profile, null, 2));
          return;
        }
        logger.info("=== OPENFOX FOX PROFILE ===");
        logger.info(`${profile.displayName}  ${profile.address}`);
        logger.info(
          `Groups: ${profile.stats.groupCount} total, ${profile.stats.activeGroupCount} active`,
        );
        logger.info(
          `Discovery: ${profile.discovery.published ? `published (${profile.discovery.capabilityNames.length} capabilities)` : "not published"}`,
        );
        logger.info(
          `Unread notifications: ${profile.stats.unreadNotificationCount}`,
        );
        for (const group of profile.groups.slice(0, 10)) {
          logger.info(
            `  [${group.membershipState}] ${group.name} (${group.roles.join(", ") || "no roles"})`,
          );
        }
        return;
      }
      if (subcommand === "page") {
        const snapshot = buildFoxPageSnapshot({
          db,
          config,
          address: readOption(args, "--address"),
          activityLimit: readNumberOption(args, "--activity-limit", 12),
          messageLimit: readNumberOption(args, "--messages", 10),
          announcementLimit: readNumberOption(args, "--announcements", 8),
          presenceLimit: readNumberOption(args, "--presence", 10),
        });
        const pageCommand =
          args[2] && !args[2].startsWith("--") ? args[2] : "snapshot";
        if (pageCommand === "export") {
          const output = readOption(args, "--output");
          if (!output) {
            throw new Error(
              "Usage: openfox world fox page export --output <path>",
            );
          }
          const outputPath = resolvePath(output);
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, buildFoxPageHtml(snapshot), "utf8");
          if (asJson) {
            logger.info(
              JSON.stringify(
                {
                  outputPath,
                  generatedAt: snapshot.generatedAt,
                  foxAddress: snapshot.fox.address,
                  activeGroupCount: snapshot.stats.activeGroupCount,
                },
                null,
                2,
              ),
            );
            return;
          }
          logger.info(`fox page exported: ${outputPath}`);
          return;
        }
        if (asJson) {
          logger.info(JSON.stringify(snapshot, null, 2));
          return;
        }
        logger.info("=== OPENFOX FOX PAGE ===");
        logger.info(`${snapshot.fox.displayName}  ${snapshot.fox.address}`);
        logger.info(
          `groups=${snapshot.stats.activeGroupCount}/${snapshot.stats.groupCount} presence=${snapshot.stats.presenceCount} activity=${snapshot.stats.recentActivityCount} messages=${snapshot.stats.messageCount}`,
        );
        logger.info(
          `capabilities=${snapshot.stats.capabilityCount} roles=${Object.keys(snapshot.roleSummary).length ? Object.entries(snapshot.roleSummary).map(([role, count]) => `${role}=${count}`).join(", ") : "none"}`,
        );
        for (const activity of snapshot.recentActivity.slice(0, 5)) {
          logger.info(`${activity.occurredAt}  ${activity.kind}`);
          logger.info(`  ${activity.title}`);
        }
        return;
      }
      if (subcommand !== "profile") {
        throw new Error(`Unknown world fox command: ${subcommand}`);
      }
    }

    if (command === "group") {
      const subcommand = args[1] || "page";
      if (subcommand !== "page") {
        throw new Error(`Unknown world group command: ${subcommand}`);
      }
      const groupId = readOption(args, "--group");
      if (!groupId) {
        throw new Error("Usage: openfox world group page --group <group-id>");
      }
      const snapshot = buildGroupPageSnapshot(db, {
        groupId,
        messageLimit: readNumberOption(args, "--messages", 20),
        announcementLimit: readNumberOption(args, "--announcements", 10),
        eventLimit: readNumberOption(args, "--events", 20),
        presenceLimit: readNumberOption(args, "--presence", 20),
      });
      const pageCommand =
        args[2] && !args[2].startsWith("--") ? args[2] : "snapshot";
      if (pageCommand === "export") {
        const output = readOption(args, "--output");
        if (!output) {
          throw new Error(
            "Usage: openfox world group page export --group <group-id> --output <path>",
          );
        }
        const outputPath = resolvePath(output);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, buildGroupPageHtml(snapshot), "utf8");
        if (asJson) {
          logger.info(
            JSON.stringify(
              {
                outputPath,
                generatedAt: snapshot.generatedAt,
                groupId: snapshot.group.groupId,
                activeMemberCount: snapshot.stats.activeMemberCount,
              },
              null,
              2,
            ),
          );
          return;
        }
        logger.info(`group page exported: ${outputPath}`);
        return;
      }
      if (asJson) {
        logger.info(JSON.stringify(snapshot, null, 2));
        return;
      }
      logger.info("=== OPENFOX GROUP PAGE ===");
      logger.info(`${snapshot.group.name}  [${snapshot.group.visibility}]`);
      logger.info(
        `members=${snapshot.stats.activeMemberCount}/${snapshot.stats.memberCount} channels=${snapshot.stats.channelCount} announcements=${snapshot.stats.announcementCount}`,
      );
      logger.info(
        `join=${snapshot.group.joinMode} presence=${snapshot.stats.presenceCount} messages=${snapshot.stats.messageCount}`,
      );
      return;
    }

    if (command === "shell") {
      const subcommand =
        args[1] && !args[1].startsWith("--") ? args[1] : "snapshot";
      const snapshot = buildMetaWorldShellSnapshot({
        db,
        config,
        feedLimit: readNumberOption(args, "--feed", 16),
        notificationLimit: readNumberOption(args, "--notifications", 12),
        boardLimit: readNumberOption(args, "--boards", 8),
        directoryLimit: readNumberOption(args, "--directory", 12),
        groupPageLimit: readNumberOption(args, "--groups", 3),
      });

      if (subcommand === "snapshot") {
        if (asJson) {
          logger.info(JSON.stringify(snapshot, null, 2));
          return;
        }
        logger.info("=== OPENFOX METAWORLD SHELL ===");
        logger.info(
          `${snapshot.fox.displayName}  ${snapshot.fox.address}`,
        );
        logger.info(
          `groups=${snapshot.fox.stats.activeGroupCount} notifications=${snapshot.notifications.unreadCount} presence=${snapshot.presence.activeCount} feed=${snapshot.feed.items.length}`,
        );
        logger.info(
          `directory: foxes=${snapshot.directories.foxes.items.length} groups=${snapshot.directories.groups.items.length}`,
        );
        for (const group of snapshot.activeGroups) {
          logger.info(
            `  ${group.group.name}  members=${group.stats.activeMemberCount} channels=${group.stats.channelCount} announcements=${group.stats.announcementCount}`,
          );
        }
        return;
      }

      if (subcommand === "export") {
        const output = readOption(args, "--output");
        if (!output) {
          throw new Error(
            "Usage: openfox world shell export --output <path>",
          );
        }
        const outputPath = resolvePath(output);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(
          outputPath,
          buildMetaWorldShellHtml(snapshot),
          "utf8",
        );
        if (asJson) {
          logger.info(
            JSON.stringify(
              {
                outputPath,
                generatedAt: snapshot.generatedAt,
                foxAddress: snapshot.fox.address,
                activeGroupCount: snapshot.activeGroups.length,
              },
              null,
              2,
            ),
          );
          return;
        }
        logger.info(`metaWorld shell exported: ${outputPath}`);
        return;
      }

      throw new Error(`Unknown world shell command: ${subcommand}`);
    }

    if (command === "site") {
      const subcommand = args[1] || "export";
      if (subcommand !== "export") {
        throw new Error(`Unknown world site command: ${subcommand}`);
      }
      const outputDir = readOption(args, "--output-dir");
      if (!outputDir) {
        throw new Error(
          "Usage: openfox world site export --output-dir <path>",
        );
      }
      const result = await exportMetaWorldSite({
        db,
        config,
        outputDir: resolvePath(outputDir),
        foxLimit: readNumberOption(args, "--foxes", 50),
        groupLimit: readNumberOption(args, "--groups", 50),
      });
      if (asJson) {
        logger.info(JSON.stringify(result, null, 2));
        return;
      }
      logger.info(`metaWorld site exported: ${result.outputDir}`);
      logger.info(`  shell: ${result.shellPath}`);
      logger.info(`  foxes: ${result.foxPages.length}`);
      logger.info(`  groups: ${result.groupPages.length}`);
      logger.info(`  manifest: ${result.manifestPath}`);
      return;
    }

    if (command === "presence") {
      const subcommand = args[1] || "list";
      if (subcommand === "publish") {
        const status = (readOption(args, "--status") || "online") as WorldPresenceStatus;
        if (
          status !== "online" &&
          status !== "busy" &&
          status !== "away" &&
          status !== "recently_active"
        ) {
          throw new Error(
            "Invalid --status value: expected online, busy, away, or recently_active",
          );
        }
        const record = publishWorldPresence({
          db,
          actorAddress: config.walletAddress,
          agentId: config.agentId,
          displayName:
            config.agentDiscovery?.displayName?.trim() || config.name,
          status,
          summary: readOption(args, "--summary"),
          groupId: readOption(args, "--group"),
          ttlSeconds: readNumberOption(args, "--ttl-seconds", 120),
        });
        logger.info(asJson ? JSON.stringify(record, null, 2) : `Presence published: ${record.actorAddress} ${record.effectiveStatus}`);
        return;
      }
      if (subcommand === "list") {
        const status = readOption(args, "--status") || "all";
        if (
          status !== "all" &&
          status !== "online" &&
          status !== "busy" &&
          status !== "away" &&
          status !== "recently_active" &&
          status !== "expired"
        ) {
          throw new Error(
            "Invalid --status value: expected all, online, busy, away, recently_active, or expired",
          );
        }
        const snapshot = buildWorldPresenceSnapshot(db, {
          groupId: readOption(args, "--group"),
          status,
          includeExpired: args.includes("--include-expired"),
          limit: readNumberOption(args, "--limit", 25),
        });
        if (asJson) {
          logger.info(JSON.stringify(snapshot, null, 2));
          return;
        }
        logger.info("=== OPENFOX WORLD PRESENCE ===");
        logger.info(snapshot.summary);
        for (const item of snapshot.items) {
          const scope = item.groupName ? ` [${item.groupName}]` : "";
          logger.info(`${item.lastSeenAt}  ${item.effectiveStatus}${scope}`);
          logger.info(`  ${item.displayName || item.agentId || item.actorAddress}`);
          if (item.summary) {
            logger.info(`  ${item.summary}`);
          }
        }
        return;
      }
      throw new Error(`Unknown world presence command: ${subcommand}`);
    }

    if (command === "notification") {
      const subcommand = args[1] || "read";
      const notificationId = readOption(args, "--id");
      if (!notificationId) {
        throw new Error("Usage: openfox world notification <read|dismiss> --id <notification-id>");
      }
      if (subcommand === "read") {
        const state = markWorldNotificationRead(db, notificationId);
        logger.info(asJson ? JSON.stringify(state, null, 2) : `Marked as read: ${notificationId}`);
        return;
      }
      if (subcommand === "dismiss") {
        const state = dismissWorldNotification(db, notificationId);
        logger.info(asJson ? JSON.stringify(state, null, 2) : `Dismissed: ${notificationId}`);
        return;
      }
      throw new Error(`Unknown world notification command: ${subcommand}`);
    }

    throw new Error(`Unknown world command: ${command}`);
  } finally {
    db.close();
  }
}

// ─── Status Command (extracted to src/commands/status.ts) ──────

// ─── Main Run (extracted to src/runtime/run.ts) ────────────────

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
