/**
 * OpenFox integration wrapper for proofverify.verify-attestations.
 *
 * Delegates TLSNotary attestation validation to openskills/proofverify,
 * which uses the native module for cryptographic or structural verification.
 */
import { join } from "node:path";
import { homedir } from "node:os";

export async function run(input, context) {
  const { run: coreRun } = await import(
    join(homedir(), ".agents", "skills", "openskills", "skills", "proofverify", "scripts", "verify-attestations.mjs")
  );
  return coreRun(input);
}
