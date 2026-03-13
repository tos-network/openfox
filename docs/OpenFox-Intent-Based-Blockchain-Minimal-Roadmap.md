# OpenFox Intent-Based Blockchain Minimal Roadmap

## 1. Goal

The goal is not to rename delegated execution as "intents."

The goal is to turn the current stack into a true intent-based system where:

- a user or agent submits a typed intent, not a pre-built final transaction
- one or more solvers discover that intent and compete to satisfy it
- `gtos` validates that the chosen fill satisfies the intent's constraints
- `tolang` provides machine-readable intent surfaces and safe fill boundaries
- `OpenFox` authors, routes, solves, monitors, and settles those intents

In one sentence:

`gtos` should settle intents, `tolang` should describe satisfiable intent surfaces,
and `OpenFox` should operate the requester and solver economy around them.

## 2. Current Ground Truth

Today the stack is already agent-native, but it is still transaction-native.

What already exists:

- `gtos` provides native transactions, account abstraction, sponsorship, discovery,
  and settlement
- `tolang` provides agent-native contracts, delegation, capabilities, effects,
  gas bounds, and machine-readable ABI metadata
- `OpenFox` already acts as a long-running requester, provider, signer-provider,
  paymaster-provider, and task-market runtime

What is still missing:

- a first-class `Intent` network object
- an intent pool or intent gossip layer
- protocol-native fill validation against intent constraints
- a standard solver role and fill receipt model
- canonical intent status, cancellation, and overfill protection

So the current stack is:

`intent -> delegated execution request -> native transaction -> settlement`

The target stack is:

`intent -> solver discovery/competition -> fill transaction(s) -> intent-aware settlement`

## 3. Minimal Definition of Done

The stack should be called a true intent-based blockchain only when all of the
following are true:

1. A requester can submit a signed `IntentEnvelope` without constructing the final
   execution path.
2. Solvers can discover, simulate, quote, and attempt fills for that intent.
3. `gtos` can validate that a fill satisfies the signed intent constraints.
4. The protocol can track `open`, `filled`, `cancelled`, `expired`, and
   optionally `partially_filled` intent states.
5. Receipts can attribute principal, solver, sponsor, and intent hash.
6. `OpenFox` can operate in requester mode, solver mode, sponsor mode, and watch
   mode using one coherent runtime model.

## 4. Design Constraints

The minimal roadmap should keep these constraints:

- Do not replace native transactions. Fills still settle as transactions.
- Do not move solver path search on chain.
- Do not begin with a fully general global execution auction.
- Do not make v1 depend on encrypted intents, ZK-heavy proving, or private orderflow.
- Do not collapse repository boundaries between `gtos`, `tolang`, and `OpenFox`.
- Do not require a new contract language just for intents.

This is intentionally narrower than a universal intent engine for every possible
market and application.

## 5. Intent v1 Scope

Intent v1 should begin with one general family:

- `ExecutionIntent`

`ExecutionIntent` is a typed signed object that describes:

- principal identity
- target application or contract surface
- allowed solver knobs
- required outcome
- max cost / fee / slippage / value bounds
- deadline
- nonce and cancel domain
- fill mode: `single_fill` or `partial_fill`
- optional sponsor requirement or sponsor preference

The key design rule is:

The requester signs constraints and desired outcome, not the final execution path.

Domain-specific products such as task payout, oracle settlement, or storage renewal
should initially be expressed as templates over `ExecutionIntent`, not as separate
protocol families.

## 6. Phase 1: Canonical Intent Envelope and Off-Chain Intent Loop

### Goal

Introduce a first-class intent object without changing final settlement yet.

### `gtos`

- define canonical `IntentEnvelope` hashing and signing rules
- add JSON-RPC for:
  - `tos_sendIntent`
  - `tos_getIntent`
  - `tos_cancelIntent`
  - `tos_intentStatus`
  - `tos_estimateIntent`
- add a local `intentpool` separate from the transaction pool
- propagate intents over p2p or existing request/response surfaces
- index intent lifecycle by `intent_hash`

### `tolang`

- extend ABI/artifact output with `intent_surfaces`
- let contracts publish solver-consumable metadata:
  - target surface ID
  - required capabilities
  - allowed mutable parameters
  - hard bounds
  - expected effects
  - settlement-relevant events
- add a minimal annotation to mark a function or contract surface as intent-fillable

### `OpenFox`

- add requester-side intent authoring
- add solver-side intent intake and simulation
- add local quote generation and policy checks
- allow private RFQ mode and public broadcast mode
- persist intent, quote, and decision records

### Acceptance Criteria

- one OpenFox node can submit an `ExecutionIntent`
- two OpenFox solver nodes can discover and simulate that intent
- at least one solver can return a quote without receiving the final path upfront
- the requester can accept one quote and proceed to a normal transaction settlement

This phase proves that the stack has a real intent object and a real solver loop,
even before protocol-native fill validation exists.

## 7. Phase 2: Intent-Aware Fill Validation in `gtos`

### Goal

Move from "intent as off-chain negotiation" to "intent as protocol-checked execution."

### `gtos`

- add `IntentFill` transaction support, or add an intent authorization block to the
  native transaction envelope
- require each fill to include:
  - `intent_hash`
  - principal authorization
  - solver identity
  - optional sponsor authorization
  - fill amount or fill fraction
  - settlement metadata
- validate:
  - signature
  - expiry
  - nonce and cancellation
  - no overfill
  - cost/value/slippage bounds
  - target-surface compatibility
  - allowed solver parameter changes
- emit canonical receipts with:
  - `intent_hash`
  - `principal`
  - `solver`
  - `sponsor`
  - `fill_status`
  - `fill_amount`

### `tolang`

- provide a canonical mapping from `intent_surface` metadata to runtime checks
- make effect metadata strong enough for safe solver parameterization
- expose event schemas and settlement hooks that `gtos` can index reliably
- define when a surface is:
  - `quote_only`
  - `single_fill`
  - `partial_fill`

### `OpenFox`

- add fill submission flow for solvers
- add watcher flow for principals and operators
- show intent state, winning solver, and fill receipts in operator UX
- reuse existing signer-provider and paymaster-provider flows inside the fill path

### Acceptance Criteria

- a solver can submit a fill transaction that references an intent
- `gtos` rejects invalid or over-bounded fills
- `gtos` accepts a valid fill and records an intent-aware receipt
- the principal can inspect the intent state without reconstructing it from raw transactions

This is the first point where the system becomes protocol-level intent-aware.

## 8. Phase 3: Minimal Solver Market

### Goal

Turn the intent flow into a real execution market without overbuilding v1.

### `gtos`

- support first-valid-fill or best-valid-fill policy for v1
- support optional partial fill accounting
- keep intent status canonical across multiple competing fills
- expose solver-attributed fill history over RPC

### `tolang`

- allow contracts to declare whether a surface is suitable for:
  - open competition
  - private RFQ
  - partial fill
- add machine-readable fee and settlement hints for solvers

### `OpenFox`

- define canonical solver capabilities:
  - `intent.solve`
  - `intent.quote`
  - `intent.watch`
- add discovery and routing rules for public and private solver selection
- add automatic best-quote selection under principal policy
- add solver reputation inputs from observed fill outcomes
- add retry and fallback if the preferred solver fails or times out

### Acceptance Criteria

- one requester can broadcast an intent to multiple candidate solvers
- multiple solvers can compete without corrupting canonical state
- the requester can choose between private RFQ and open competition
- solver history is visible enough for basic reputation and routing decisions

At the end of this phase, the stack is a minimal but real intent-based blockchain.

## 9. Phase 4: Safety, Privacy, and Capital Efficiency

This phase is not required to cross the "true intent-based" threshold, but it is
required for a stronger market.

### Recommended additions

- encrypted or selectively disclosed intents
- solver stake, bond, or slashable quality guarantees
- solver-side commit/reveal for sensitive flows
- sponsor-aware partial fills
- intent bundles that settle through more than one transaction when necessary
- richer cancellation and replacement policies

This phase should start only after Phases 1 through 3 are stable.

## 10. Repository Ownership

The implementation boundary should stay explicit.

### `gtos` owns

- intent envelope rules
- intent hashing and signature verification
- intentpool and RPC exposure
- canonical fill validation
- intent lifecycle state
- receipts and indexing
- p2p propagation rules

### `tolang` owns

- intent-surface annotations
- machine-readable solver constraints
- effect metadata required for safe fills
- contract-level fillability semantics
- ABI/artifact publication for solver tooling

### `OpenFox` owns

- requester UX and policy
- solver runtime and quote engine
- discovery and routing logic
- watch mode and operator summaries
- retry, fallback, and persistence
- integration with signer-provider and paymaster-provider services

## 11. What Not to Do Yet

To keep the roadmap minimal, do not start with:

- a universal cross-chain intent engine
- a global on-chain combinatorial auction
- encrypted private orderflow as a prerequisite
- a full economic slashing system for every solver mistake
- contract authors writing arbitrary custom satisfaction verifiers in v1
- many protocol intent families when one `ExecutionIntent` family is enough

The first goal is not to solve every market design problem.
The first goal is to move the stack from transaction-native delegated execution
to protocol-native intent settlement.

## 12. Recommended First Build Order

The practical build order should be:

1. `tolang`: publish `intent_surface` metadata in ABI/artifacts
2. `gtos`: define `IntentEnvelope`, hashing, RPC, and local intentpool
3. `OpenFox`: implement requester intent authoring and solver quote loop
4. `gtos`: add canonical fill validation and intent-aware receipts
5. `OpenFox`: add public solver capability, routing, and watch mode

This ordering forces the stack to become useful early, before the more expensive
market-design work begins.

## 13. End State

The minimal successful end state is:

- a user interacts with OpenFox by expressing an objective and constraints
- OpenFox emits a signed `ExecutionIntent`
- one or more solvers discover that intent and compete to satisfy it
- a fill is submitted as a native settlement action on `gtos`
- `gtos` validates that the fill satisfies the intent
- `tolang` contract metadata makes solver behavior safe and machine-readable
- receipts, operator UX, and discovery all speak the language of intents, not only transactions

At that point, the stack is no longer merely agent-native.
It is a true intent-based blockchain stack with a minimal but coherent execution market.
