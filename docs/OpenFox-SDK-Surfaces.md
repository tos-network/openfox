# OpenFox SDK and Runtime Surfaces

OpenFox now sits on top of two reusable surfaces:

## 1. `tosdk`

Use `tosdk` directly when you need:

- native account and address handling
- transaction signing
- native public and wallet clients
- settlement receipt helpers
- market binding helpers
- repository examples for native wallets and requester/provider integrations

## 2. `openfox`

Use OpenFox when you need:

- a long-running runtime
- discovery and gateway participation
- paid provider surfaces
- task marketplace automation
- operator UX
- payment ledgering and retries

## Practical rule

- choose `tosdk` for low-level integration
- choose OpenFox for agent runtime integration

That separation is the main productization boundary for the current stack.

See also:

- `../tosdk/examples/network-wallet.ts`
- `../tosdk/examples/provider-clients.ts`
- `../tosdk/examples/storage-and-artifacts.ts`
