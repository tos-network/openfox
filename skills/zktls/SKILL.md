---
name: zktls
description: Deterministic evidence bundle construction backend for bounded capture lanes.
provider-backends:
  bundle:
    entry: scripts/bundle.mjs
    description: Turn bounded capture fields into a stable bundle receipt.
---
Use this skill to package fetched public evidence into a stable bundle format.
Load `references/provider-backend.md` for the stage summary.
Load `references/bundle-contract.json` for the machine-readable I/O contract.
