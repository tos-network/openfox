import { describe, expect, it } from "vitest";
import {
  parseNewsFetchCaptureSkillResult,
  parseProofVerifySkillResult,
  parseStorageGetSkillResult,
  parseStoragePutSkillResult,
  parseZkTlsBundleSkillResult,
} from "../agent-discovery/skill-backend-contracts.js";

describe("skill backend contracts", () => {
  it("accepts valid news fetch capture output", () => {
    expect(
      parseNewsFetchCaptureSkillResult({
        canonicalUrl: "https://news.example/story",
        httpStatus: 200,
        contentType: "text/html",
        articleSha256: "0x" + "a".repeat(64),
        articleText: "hello",
      }),
    ).toMatchObject({
      canonicalUrl: "https://news.example/story",
      httpStatus: 200,
    });
  });

  it("rejects invalid zkTLS bundle output", () => {
    expect(() =>
      parseZkTlsBundleSkillResult({
        format: "bundle",
        bundleSha256: "not-a-hash",
        bundle: {},
      }),
    ).toThrow(/bundleSha256/);
  });

  it("rejects invalid proof verifier verdicts", () => {
    expect(() =>
      parseProofVerifySkillResult({
        verdict: "maybe",
        summary: "bad",
        metadata: {},
        verifierReceiptSha256: "0x" + "b".repeat(64),
      }),
    ).toThrow(/verdict/);
  });

  it("accepts valid storage put output", () => {
    expect(
      parseStoragePutSkillResult({
        objectId: "abc123",
        contentType: "text/plain",
        contentSha256: "0xabc",
        sizeBytes: 4,
        ttlSeconds: 60,
        expiresAt: 1234,
        bufferBase64: "aGVsbA==",
      }),
    ).toMatchObject({
      objectId: "abc123",
      ttlSeconds: 60,
    });
  });

  it("accepts valid storage get rejection output", () => {
    expect(
      parseStorageGetSkillResult({
        status: "rejected",
        httpStatus: 410,
        reason: "object expired",
        pruneExpired: true,
      }),
    ).toEqual({
      status: "rejected",
      httpStatus: 410,
      reason: "object expired",
      pruneExpired: true,
    });
  });
});
