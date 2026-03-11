import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportBundledPack,
  lintBundledPack,
  listBundledPacks,
  readBundledPackReadme,
} from "../commands/packs.js";

describe("control-plane packs", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("lists bundled packs with versioned descriptions", () => {
    const items = listBundledPacks();
    expect(items.some((item) => item.name === "fleet-automation-v1")).toBe(true);
    expect(items.some((item) => item.name === "market-operations-v1")).toBe(true);
  });

  it("reads bundled pack readmes", () => {
    const text = readBundledPackReadme("fleet-automation-v1");
    expect(text).toContain("Fleet Automation");
  });

  it("exports a bundled pack and lints it successfully", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-pack-"));
    const outputPath = path.join(tempDir, "fleet-automation-v1");
    const result = exportBundledPack({
      name: "fleet-automation-v1",
      outputPath,
    });

    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(path.join(outputPath, "pack.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, "policies", "signer.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, "manifests", "fleet.public.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(outputPath, "contracts", "fleet-recovery-callback.json"))).toBe(true);

    const lint = lintBundledPack(outputPath);
    expect(lint.errors).toEqual([]);
    expect(lint.warnings).toEqual([]);
  });

  it("reports missing required exports when a pack is incomplete", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-pack-"));
    const packPath = path.join(tempDir, "broken-pack");
    fs.mkdirSync(packPath, { recursive: true });
    fs.writeFileSync(
      path.join(packPath, "pack.json"),
      JSON.stringify({
        name: "broken-pack",
        version: "1",
        policies: ["policies/missing.json"],
        manifests: ["manifests/missing.json"],
        contracts: ["contracts/missing.json"],
      }),
      "utf8",
    );
    const lint = lintBundledPack(packPath);
    expect(lint.errors).toEqual(
      expect.arrayContaining([
        "missing policy export: policies/missing.json",
        "missing manifest export: manifests/missing.json",
        "missing contract example: contracts/missing.json",
      ]),
    );
  });
});
