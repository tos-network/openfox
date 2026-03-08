# OpenFox Integration Roadmap

## 1. Goal

The goal is not merely to make `openfox` "support another chain." The goal is to make an `openfox` agent/operator able to:

- hold and use a `TOS` wallet
- sign and send transactions on the `TOS` network
- pay for real services through `x402`
- take jobs, perform oracle and observation work, and earn revenue on `TOS`

In one sentence:

`openfox` should become a payable, executable, revenue-generating agent runtime on `TOS`.

## 2. What Is Already Done ✅

### 2.1 On the OpenFox Side ✅

- `TOS` address derivation and local wallet integration are implemented
- native `TOS` transfer signing and submission are implemented
- `tos-status` and `tos-send` CLI commands are implemented
- the `x402` client recognizes `tos:<chainId>` and can construct TOS payments
- when a service offers both USDC and TOS payment requirements, OpenFox prefers TOS

### 2.2 On the TOS/GTOS Side ✅

- `x402` header encoding and decoding are implemented
- native `TOS` transaction envelope parsing and verification are implemented
- `x402` HTTP middleware is implemented
- the minimal demo service `cmd/x402demo` is implemented
- real `TOS x402` end-to-end testing on a local three-node network has been completed
- the RPC signer inference bug has been fixed so validator-related flows do not incorrectly fall back to `secp256k1`

### 2.3 Current Conclusion ✅

The minimum end-to-end path is already working:

`openfox wallet -> TOS native tx signing -> x402 payment -> gtos/x402 verification -> paid endpoint`

However, this is still "integrated and testable," not yet "production-ready and scalable."

## 3. Overall Roadmap

The recommended path is to move in five stages.

### Phase 0: Core Path Working ✅

Status: completed

Goals:

- wallet creation works
- address derivation works
- native transfer submission works
- the minimum `x402` payment path works

Deliverables:

- the `TOS` SDK in `openfox`
- `gtos/x402`
- `x402demo`

### Phase 1: Wallet and Onboarding Productization

Status: not complete

Goal:

- a new operator should be able to obtain a usable `TOS` wallet and perform first on-chain actions within minutes

Required work:

- officially integrate `TOS` setup into the `openfox` setup flow
- add one-click funding for local devnet and testnet
- clearly define the boundary between `secp256k1` wallets and other signer types
- provide a complete signer metadata bootstrap flow for non-`secp256k1` accounts
- improve errors for missing `TOS_RPC_URL`, insufficient balance, nonce conflicts, and related issues

Acceptance criteria:

- a fresh machine can complete `install -> create wallet -> check balance -> receive funds -> send transaction`
- no manual source reading or handcrafted RPC requests are required

### Phase 2: Launch Real Paid Services

Status: not complete

Goal:

- move beyond demo endpoints and offer paid services with real value output

The initial scope should stay narrow and start with only two categories.

#### A. Paid Oracle Resolution API

Suggested endpoints:

- `POST /oracle/quote`
- `POST /oracle/resolve`
- `GET /oracle/result/:id`

Service output:

- event market resolution
- scalar market value resolution
- evidence summary
- canonical result output

#### B. Paid Observation API

Suggested endpoints:

- `POST /observe`
- `GET /jobs/:id`

Service output:

- one-shot observation
- windowed observation
- standardized observation receipt

Required work in this phase:

- connect `x402` middleware to real business handlers
- introduce payment idempotency
- bind payment to the underlying resource or request
- define a minimum pricing model
- define a standard result structure

Acceptance criteria:

- the user pays once in `TOS`
- the user receives a real business result instead of a test JSON payload

### Phase 3: On-Chain Task and Settlement Integration

Status: not complete

Goal:

- turn paid services from purely off-chain APIs into services integrated with the `TOS` contract and task system

Suggested scope:

- contract-based task and oracle market
- binding between query/job IDs and on-chain state
- standard result hash, receipt, and settlement interfaces
- scheduler integration

Suggested first targets:

- observation job contract
- oracle result contract
- result hash and receipt helper

Not recommended at this stage:

- a fully general agent execution market
- complex dispute trees
- heavy proof-verifier economics

Acceptance criteria:

- a query or job can complete a full lifecycle: creation, payment, execution, callback, and settlement

### Phase 4: Productionize the x402 Server Side

Status: not complete

Goal:

- turn the current "works in practice" `x402` path into a reliable long-term public payment entrypoint

Required work:

- receipt and confirmation policy
- duplicate payment detection
- replay protection
- nonce conflict and replacement handling
- recovery semantics after broadcast failure
- server-side payment ledger
- auditable binding between payment and business result

Acceptance criteria:

- the server handles duplicate requests, broadcast failures, timeouts, and retries correctly
- the same payment envelope cannot be replayed to unlock the same service repeatedly

### Phase 5: Ecosystem and SDK Productization

Status: not complete

Goal:

- let third-party agents and operators integrate independently, without manual assistance

Suggested work items:

- extract `tos-agent-kit` into an independent package
- prepare a minimum quickstart
- prepare `web4.ai`, MCP, and API service integration examples
- provide a local development template
- provide task sponsor and service operator examples

Acceptance criteria:

- a third-party developer can complete integration without needing to study internal implementation details

## 4. Near-Term Priorities

Suggested priority order:

### P0: Do Immediately

- connect `x402` to a real `paid oracle API`
- define a minimum result schema
- add request and payment idempotency on the server side
- stabilize local end-to-end integration scripts

### P1: Do Next

- complete wallet initialization and funding guidance in `openfox`
- design the observation job API
- design on-chain query/job identifiers and result callback interfaces

### P2: Do Later

- extract `tos-agent-kit`
- write developer documentation for testnet usage
- build operator onboarding materials

## 5. What Not to Do Yet

- do not start with a general agent execution marketplace
- do not start with a complex oracle dispute system
- do not start with a full `zkTLS + SNARK` proof pipeline
- do not push all application logic into native chain modules

The more reasonable strategy for now is:

- `TOS` provides infrastructure
- `openfox` provides agent runtime integration
- paid services begin with `oracle + observation`

## 6. Recommended Next Step

There are only two next steps that matter most:

1. build a real `paid oracle API` inside `gtos`
2. build a complete example in `openfox`: initialize a wallet and call the paid oracle API

Only after these two steps are complete can `openfox + TOS + x402` be considered beyond "successful integration" and into "usable product prototype."
