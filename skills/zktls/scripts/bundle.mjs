import { createHash } from "node:crypto";
import { runCliWorker, unwrapCliWorkerResult } from "../../_shared/cli-worker.mjs";

export async function run(input, context) {
  const worker = context?.config?.agentDiscovery?.newsFetchServer?.zktlsWorker;
  if (worker?.command) {
    const workerResult = await runCliWorker(worker, {
      schema_version: "openfox.cli-worker.v1",
      worker: "zktls.bundle",
      request_id: input?.request?.request_nonce || `newsfetch-${Date.now()}`,
      request: input?.request ?? {},
      capture: input?.capture ?? {},
      options: {
        sourcePolicyId:
          input?.request?.source_policy_id ||
          context?.config?.agentDiscovery?.newsFetchServer?.defaultSourcePolicyId ||
          context?.config?.agentDiscovery?.newsFetchServer?.capability ||
          "news.fetch",
        maxBundleBytes: worker.maxStdoutBytes || 1024 * 1024,
      },
      context: {
        fetchedAt: Number(input?.fetchedAt || Math.floor(Date.now() / 1000)),
      },
    });
    if (workerResult.exitCode !== 0) {
      throw new Error(
        `zktls.bundle CLI worker failed with exit code ${workerResult.exitCode}${
          workerResult.stderr ? `: ${workerResult.stderr}` : ""
        }`,
      );
    }
    return unwrapCliWorkerResult(workerResult.stdout, "zktls.bundle");
  }

  const request = input?.request ?? {};
  const capture = input?.capture ?? {};
  const fetchedAt = Number(input?.fetchedAt || Math.floor(Date.now() / 1000));
  const bundle = {
    version: 1,
    backend: "skill:zktls.bundle",
    fetched_at: fetchedAt,
    source_url: request.source_url,
    canonical_url: capture.canonicalUrl,
    source_policy_id:
      request.source_policy_id ||
      context?.config?.agentDiscovery?.newsFetchServer?.defaultSourcePolicyId ||
      null,
    publisher_hint: request.publisher_hint || null,
    headline_hint: request.headline_hint || null,
    http_status: capture.httpStatus,
    content_type: capture.contentType,
    article_sha256: capture.articleSha256,
    headline: capture.headline || null,
    publisher: capture.publisher || null,
    article_preview: capture.articleText || null,
  };
  return {
    format: "skill_zktls_bundle_v1",
    bundle,
    bundleSha256: `0x${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`,
    backend: "skill:zktls.bundle",
  };
}
