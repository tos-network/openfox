# OpenFox Intent Implementation Checklist

Status: draft  
Audience: maintainers planning cross-repo implementation work

## 1. Goal

This checklist turns the intent roadmap into executable work across:

- `gtos`
- `tolang`
- `OpenFox`

It is intentionally ordered so the stack becomes useful before the full solver
market exists.

## 2. Recommended Delivery Order

1. publish `intent_surface` metadata in `tolang`
2. add `IntentEnvelope` and `intentpool` support in `gtos`
3. add requester and solver quote loops in `OpenFox`
4. add `intent_auth` fill validation and `IntentReceipt` indexing in `gtos`
5. add public solver discovery, operator UX, and watcher flows in `OpenFox`

## 3. Milestones

### Milestone A: Intent Metadata Exists

Definition:

- contracts can declare fillable surfaces
- artifacts expose machine-readable solver constraints

Blocking dependency:

- none

Primary owner:

- `tolang`

### Milestone B: Intents Can Be Authored and Broadcast

Definition:

- a requester can sign and submit an `IntentEnvelope`
- a local node stores it in an `intentpool`
- solver runtimes can discover it

Blocking dependency:

- Milestone A recommended, but not strictly required for a dummy prototype

Primary owners:

- `gtos`
- `OpenFox`

### Milestone C: Solvers Can Quote and Fill

Definition:

- solvers can simulate an intent and produce a quote
- a selected solver can submit a fill transaction with `intent_auth`

Blocking dependency:

- Milestone B

Primary owners:

- `OpenFox`
- `gtos`

### Milestone D: Protocol-Aware Intent Settlement Exists

Definition:

- `gtos` rejects invalid fills and indexes valid ones as intent-aware receipts

Blocking dependency:

- Milestone C

Primary owners:

- `gtos`
- `tolang`

### Milestone E: Solver Market and Operator Visibility

Definition:

- multiple solvers can compete
- principals and operators can inspect intent state, solver history, and failures

Blocking dependency:

- Milestone D

Primary owners:

- `OpenFox`

## 4. `gtos` Checklist

### 4.1 Core Types and Encoding

- [ ] Add `ExecutionIntent`, `IntentEnvelope`, `IntentCancel`, `IntentAuth`, and
  `IntentReceipt` types under `core/types/`
- [ ] Add deterministic encoding and hashing helpers under `core/types/`
- [ ] Extend JSON marshalling for intent-aware RPC responses in
  `core/types/transaction_marshalling.go` and receipt JSON helpers
- [ ] Add tests for intent hashing, signature verification, and round-trip
  serialization in `core/types/*_test.go`

Likely touchpoints:

- `core/types/transaction.go`
- `core/types/transaction_marshalling.go`
- `core/types/transaction_signing.go`
- `core/types/receipt.go`
- `core/types/gen_receipt_json.go`
- `core/types/hashing.go`

### 4.2 RPC and Node API

- [ ] Expose `tos_sendIntent`
- [ ] Expose `tos_getIntent`
- [ ] Expose `tos_intentStatus`
- [ ] Expose `tos_cancelIntent`
- [ ] Expose `tos_estimateIntent`
- [ ] Add RPC response shapes and tests

Likely touchpoints:

- `internal/tosapi/api.go`
- `rpc/types.go`
- `rpc/client.go`
- `node/rpcstack.go`
- `tosclient/`

### 4.3 Intent Pool

- [ ] Add a local `intentpool` distinct from the txpool
- [ ] Validate signature, expiry, chain ID, and nonce shape on admission
- [ ] Support local removal on cancellation or expiry
- [ ] Add metrics and operator visibility

Likely touchpoints:

- new package such as `core/intentpool/`
- `core/types/`
- `metrics/` or existing node metrics hooks

### 4.4 P2P Propagation

- [ ] Decide whether Intent v1 uses a dedicated p2p message path or a narrow
  request/response path first
- [ ] Add intent gossip or fetch semantics
- [ ] Deduplicate by `intent_hash`
- [ ] Add tests for propagation and replay handling

Likely touchpoints:

- `p2p/protocol.go`
- `p2p/message.go`
- `p2p/server.go`
- `p2p/discover/`

### 4.5 Fill Validation

- [ ] Extend native transaction handling to carry `intent_auth`
- [ ] Validate intent existence and open status before execution
- [ ] Validate solver mutation bounds against the referenced surface metadata
- [ ] Reject overfill, expired, and cancelled intents
- [ ] Attribute solver and sponsor identities in receipts

Likely touchpoints:

- `core/state_transition.go`
- `core/accountsigner_sender.go`
- `core/types/signer_tx.go`
- `core/types/transaction.go`
- `core/types/receipt.go`

### 4.6 Canonical Intent State

- [ ] Track `open`, `filled`, `partially_filled`, `cancelled`, and `expired`
- [ ] Index cumulative fill amount
- [ ] Store last successful fill tx hash
- [ ] Make intent state queryable over RPC

Likely touchpoints:

- new state/index package or protocol-native storage path
- `internal/tosapi/api.go`
- receipt indexing paths

### 4.7 Testing

- [ ] Add type/unit tests
- [ ] Add RPC tests
- [ ] Add intentpool admission tests
- [ ] Add fill-validation tests for valid, expired, cancelled, and overfill cases
- [ ] Add e2e tests via `tosclient` or local multi-node harness

## 5. `tolang` Checklist

### 5.1 Language Surface

- [ ] Add an annotation or declaration form for `intent_surface`
- [ ] Decide whether intent fillability is attached to functions, contracts, or both
- [ ] Ensure the surface can declare mutable solver parameters and hard bounds

Likely touchpoints:

- `tol/parser/parser.go`
- `parse/parser.go`
- `docs/grammar/TolangParser.g4`

### 5.2 Semantic Checks

- [ ] Reject invalid or contradictory `intent_surface` declarations
- [ ] Validate `fill_mode`, mutable parameter declarations, and bound schema shape
- [ ] Reuse existing effects machinery where possible

Likely touchpoints:

- `tol/sema/sema.go`
- `tol/sema/effects.go`
- `tol/sema/agent.go`

### 5.3 Codegen and Artifact Output

- [ ] Add `intent_surfaces` to `.toc`
- [ ] Emit stable `surface_id` values
- [ ] Emit mutable parameter lists, receipt events, and hard-bounds schema
- [ ] Ensure artifact output is deterministic

Likely touchpoints:

- `tol/codegen/codegen.go`
- `docs/ABI_SPEC.md`
- `docs/FILE_FORMATS.md`
- example `.toc` outputs under `examples/`

### 5.4 Documentation and Examples

- [ ] Add one minimal fillable contract example
- [ ] Add one partial-fill example only if the semantics are already stable
- [ ] Update agent-native docs to explain how solver constraints are published

Likely touchpoints:

- `docs/AGENT-NATIVE.md`
- `docs/ABI_SPEC.md`
- `docs/FILE_FORMATS.md`
- `docs/AGENT_PROTOCOL_DRAFT*.tol`

### 5.5 Testing

- [ ] Parser tests for new syntax
- [ ] Semantic tests for invalid declarations
- [ ] Codegen tests for `.toc.intent_surfaces`
- [ ] Golden tests for stable `surface_id` output

Likely touchpoints:

- `tol/parser/parser_test.go`
- `tol/sema/sema_test.go`
- `tol/codegen/codegen_test.go`

## 6. `OpenFox` Checklist

### 6.1 Requester Runtime

- [ ] Add local intent authoring models and validation
- [ ] Add CLI or runtime flow to submit an intent
- [ ] Persist intent records, local policy decisions, and selected quotes
- [ ] Support `private_rfq` and `open` routing modes

Likely touchpoints:

- `packages/cli/src/commands/`
- `src/runtime/client.ts`
- `src/state/schema.ts`
- `src/state/database.ts`
- new package such as `src/intent/`

### 6.2 Solver Runtime

- [ ] Add intent discovery intake
- [ ] Add simulation and quote generation
- [ ] Add path selection and fill submission
- [ ] Reuse signer-provider and paymaster-provider clients where needed

Likely touchpoints:

- `src/agent-discovery/`
- `src/signer/client.ts`
- `src/paymaster/client.ts`
- `src/orchestration/`
- new package such as `src/intent/solver.ts`

### 6.3 Discovery and Routing

- [ ] Define solver discovery capability names
- [ ] Extend Agent Card metadata for solver roles
- [ ] Support requester policy for public vs private routing
- [ ] Support basic solver reputation inputs from observed fills

Likely touchpoints:

- `src/agent-discovery/types.ts`
- `src/agent-discovery/card.ts`
- `src/agent-discovery/client.ts`
- `src/operator/provider-reputation.ts`

### 6.4 Operator UX

- [ ] Show local intents and their statuses in `status`
- [ ] Surface failures and stale intents in `doctor`
- [ ] Add recent solver/fill history to dashboard and operator API
- [ ] Add watch mode for principals and sponsors

Likely touchpoints:

- `src/operator/status.ts`
- `src/operator/dashboard.ts`
- `src/operator/api.ts`
- `src/doctor/report.ts`
- `packages/cli/src/commands/status.ts`

### 6.5 Database and Audit Trails

- [ ] Add tables for intents, quotes, fills, cancellations, and solver outcomes
- [ ] Add idempotency rules for quote acceptance and fill retries
- [ ] Add audit trails linking intent hashes to tx hashes and receipts

Likely touchpoints:

- `src/state/schema.ts`
- `src/state/database.ts`
- `src/audit/execution-trails.ts`

### 6.6 Testing

- [ ] Add requester-side tests for intent authoring and validation
- [ ] Add solver tests for quote generation and fill selection
- [ ] Add discovery tests for solver role metadata
- [ ] Add database tests for intent persistence and idempotency
- [ ] Add operator UX tests for status and doctor output

Likely touchpoints:

- `src/__tests__/`

## 7. Cross-Repo Integration Tests

- [ ] one `tolang` contract publishes a valid `intent_surface`
- [ ] one `gtos` node accepts `tos_sendIntent`
- [ ] one `OpenFox` requester emits an intent using that surface
- [ ] two `OpenFox` solvers discover and quote the intent
- [ ] one solver submits a valid fill
- [ ] `gtos` emits an `IntentReceipt`
- [ ] `OpenFox` status and doctor surfaces show the final state correctly

## 8. First Thin Slice

The recommended first thin slice is:

- one `single_fill` surface
- one `private_rfq` routing mode
- no partial fills
- no encrypted intents
- no open public auction
- one solver success path and one solver rejection path

This is enough to prove protocol-native intent settlement without taking on all
future market design problems at once.

## 9. Recommended Ownership Split

- `gtos`: protocol objects, RPC, intentpool, fill validation, receipts
- `tolang`: syntax, semantics, ABI/artifact metadata
- `OpenFox`: requester UX, solver runtime, routing, persistence, operator UX

## 10. Exit Criteria for v1

Intent v1 should be considered complete only when:

1. the stack can publish a signed intent without pre-building the final path
2. at least one independent solver runtime can quote and fill it
3. `gtos` can reject invalid fills using protocol-native checks
4. `tolang` artifacts expose enough metadata for safe solver behavior
5. `OpenFox` can display and operate the lifecycle as an intent workflow rather
   than a raw transaction workflow
