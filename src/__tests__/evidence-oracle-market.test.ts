import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportBundledTemplate,
  listBundledTemplates,
} from "../commands/templates.js";
import {
  exportBundledPack,
  listBundledPacks,
} from "../commands/packs.js";

describe("evidence and oracle market packaging", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("ships reusable evidence/oracle templates, skills, and control-plane packs", () => {
    const templates = listBundledTemplates();
    expect(templates.some((item) => item.name === "evidence-market-flow")).toBe(true);
    expect(templates.some((item) => item.name === "oracle-market-flow")).toBe(true);

    expect(
      fs.existsSync(
        path.resolve("skills/evidence-market-operator/SKILL.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.resolve("skills/oracle-market-operator/SKILL.md"),
      ),
    ).toBe(true);

    const packs = listBundledPacks();
    expect(packs.some((item) => item.name === "market-operations-v1")).toBe(true);
  });

  it("exports packaged evidence and oracle flows for operator deployment", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-evidence-oracle-pack-"));

    const evidenceOutput = path.join(tempDir, "evidence-market-flow");
    exportBundledTemplate({
      name: "evidence-market-flow",
      outputPath: evidenceOutput,
    });
    expect(fs.existsSync(path.join(evidenceOutput, "operator.openfox.json"))).toBe(true);
    expect(fs.readFileSync(path.join(evidenceOutput, "README.md"), "utf8")).toContain(
      "Evidence Market Flow",
    );

    const oracleOutput = path.join(tempDir, "oracle-market-flow");
    exportBundledTemplate({
      name: "oracle-market-flow",
      outputPath: oracleOutput,
    });
    expect(fs.existsSync(path.join(oracleOutput, "operator.openfox.json"))).toBe(true);
    expect(fs.readFileSync(path.join(oracleOutput, "README.md"), "utf8")).toContain(
      "Oracle Market Flow",
    );

    const packOutput = path.join(tempDir, "market-operations-v1");
    exportBundledPack({
      name: "market-operations-v1",
      outputPath: packOutput,
    });
    expect(fs.existsSync(path.join(packOutput, "contracts", "settlement-callback.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(packOutput, "manifests", "market-operator.json"))).toBe(
      true,
    );
  });
});
