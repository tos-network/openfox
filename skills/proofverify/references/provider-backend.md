# Provider Backend Contract

Stage: `proofverify.verify`
Contract JSON: `verify-contract.json`
Version: `v1`

Input:

- `request.subject_url` or `request.subject_sha256`
- `request.proof_bundle_url` or `request.proof_bundle_sha256`
- `options.allowPrivateTargets`
- `options.requestTimeoutMs`
- `options.maxFetchBytes`

Output:

- `verdict`
- `summary`
- `metadata`
- `verifierReceiptSha256`
