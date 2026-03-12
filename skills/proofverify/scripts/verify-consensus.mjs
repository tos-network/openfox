/**
 * OpenFox integration wrapper for proofverify.verify-consensus.
 *
 * Delegates M-of-N consensus checking to openskills/proofverify (pure JS).
 */
import { join } from "node:path";
import { homedir } from "node:os";

export async function run(input, context) {
  const { run: coreRun } = await import(
    join(homedir(), ".agents", "skills", "openskills", "skills", "proofverify", "scripts", "verify-consensus.mjs")
  );
  return coreRun(input);
}
