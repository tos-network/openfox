/**
 * OpenFox wrapper for zktls.prove — delegates to openskills native module.
 *
 * Locates the native module through the agents-personal skills directory
 * (~/.agents/skills/openskills/native/).
 */
import { join } from "node:path";
import { homedir } from "node:os";

export async function run(input) {
  const request = input?.request;
  if (!request) throw new Error("missing input.request");
  if (!request.serverHost) throw new Error("missing request.serverHost");
  if (!request.notaryHost) throw new Error("missing request.notaryHost");
  if (!request.method) throw new Error("missing request.method");
  if (!request.path) throw new Error("missing request.path");

  let native;
  try {
    const nativePath = join(homedir(), ".agents", "skills", "openskills", "native", "openskills-zktls.node");
    native = await import(nativePath);
  } catch {
    return {
      error: "native binding required — install openskills and build native/ with: cd ~/.agents/skills/openskills/native && npm run build",
      backend: "skill:zktls.prove",
    };
  }

  const result = await native.prove({
    serverHost: request.serverHost,
    serverPort: request.serverPort ?? 443,
    notaryHost: request.notaryHost,
    notaryPort: request.notaryPort ?? 7047,
    request: {
      method: request.method,
      path: request.path,
      headers: request.headers || [],
      body: request.body || null,
    },
    maxSentData: request.maxSentData ?? 4096,
    maxRecvData: request.maxRecvData ?? 16384,
    revealRanges: request.revealRanges || null,
  });

  return {
    attestation: result.attestation,
    attestationSha256: result.attestationSha256,
    serverName: result.serverName,
    sentLen: result.sentLen,
    recvLen: result.recvLen,
    backend: "skill:zktls.prove",
  };
}
