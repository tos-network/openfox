import { createHash } from "node:crypto";

export async function run(input) {
  const request = input?.request ?? {};
  const capture = input?.capture ?? {};
  const fetchedAt = Number(input?.fetchedAt || Math.floor(Date.now() / 1000));
  const bundle = {
    version: 1,
    backend: "skill:zktls.bundle",
    fetched_at: fetchedAt,
    source_url: request.source_url,
    canonical_url: capture.canonicalUrl,
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
