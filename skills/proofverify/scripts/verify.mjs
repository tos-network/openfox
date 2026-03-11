import { createHash } from "node:crypto";
import {
  extractReferencedSubjectHash,
  fetchBoundedUrl,
  validateHttpTargetUrl,
} from "../../_shared/http-utils.mjs";

export async function run(input) {
  const request = input?.request ?? {};
  const options = input?.options ?? {};
  const checks = [];
  const metadata = {
    verifier_backend: "skill:proofverify.verify",
  };

  if (request.subject_url) {
    const subjectUrl = validateHttpTargetUrl(String(request.subject_url), {
      allowPrivateTargets: options.allowPrivateTargets === true,
    });
    const subject = await fetchBoundedUrl(subjectUrl, {
      timeoutMs: Number(options.requestTimeoutMs || 10_000),
      maxResponseBytes: Number(options.maxFetchBytes || 262_144),
    });
    metadata.subject = {
      canonical_url: subject.canonicalUrl,
      status: subject.status,
      content_type: subject.contentType,
      sha256: subject.bodySha256,
    };
    if (request.subject_sha256) {
      checks.push({
        label: "subject_sha256",
        ok: subject.bodySha256.toLowerCase() === String(request.subject_sha256).toLowerCase(),
        actual: subject.bodySha256,
        expected: request.subject_sha256,
      });
    }
  } else if (request.subject_sha256) {
    metadata.subject = {
      declared_sha256: request.subject_sha256,
    };
  }

  if (request.proof_bundle_url) {
    const bundleUrl = validateHttpTargetUrl(String(request.proof_bundle_url), {
      allowPrivateTargets: options.allowPrivateTargets === true,
    });
    const bundle = await fetchBoundedUrl(bundleUrl, {
      timeoutMs: Number(options.requestTimeoutMs || 10_000),
      maxResponseBytes: Number(options.maxFetchBytes || 262_144),
    });
    let parsed;
    try {
      parsed = JSON.parse(bundle.body.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const referencedSubjectHash = extractReferencedSubjectHash(parsed);
    metadata.bundle = {
      canonical_url: bundle.canonicalUrl,
      status: bundle.status,
      content_type: bundle.contentType,
      sha256: bundle.bodySha256,
      referenced_subject_sha256: referencedSubjectHash || null,
    };
    if (request.proof_bundle_sha256) {
      checks.push({
        label: "proof_bundle_sha256",
        ok:
          bundle.bodySha256.toLowerCase() ===
          String(request.proof_bundle_sha256).toLowerCase(),
        actual: bundle.bodySha256,
        expected: request.proof_bundle_sha256,
      });
    }
    if (request.subject_sha256 && referencedSubjectHash) {
      checks.push({
        label: "bundle_subject_sha256",
        ok:
          referencedSubjectHash.toLowerCase() ===
          String(request.subject_sha256).toLowerCase(),
        actual: referencedSubjectHash,
        expected: request.subject_sha256,
      });
    }
  } else if (request.proof_bundle_sha256) {
    metadata.bundle = {
      declared_sha256: request.proof_bundle_sha256,
    };
  }

  let verdict = "inconclusive";
  if (checks.length > 0) {
    verdict = checks.every((entry) => entry.ok) ? "valid" : "invalid";
  }
  const invalidCount = checks.filter((entry) => !entry.ok).length;
  const summary =
    verdict === "valid"
      ? `Verified ${checks.length} proof check${checks.length === 1 ? "" : "s"} successfully.`
      : verdict === "invalid"
        ? `Verification failed for ${invalidCount} check${invalidCount === 1 ? "" : "s"}.`
        : "No comparable hashes were available, so the result is inconclusive.";

  metadata.checks = checks;
  return {
    verdict,
    summary,
    metadata,
    verifierReceiptSha256: `0x${createHash("sha256").update(JSON.stringify({
      request,
      verdict,
      checks,
      metadata,
    })).digest("hex")}`,
    backend: "skill:proofverify.verify",
  };
}
