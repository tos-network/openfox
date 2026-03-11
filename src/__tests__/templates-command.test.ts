import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportBundledTemplate,
  listBundledTemplates,
  readBundledTemplateReadme,
} from "../commands/templates.js";

describe("bundled templates", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("lists bundled templates with descriptions", () => {
    const items = listBundledTemplates();
    expect(items.some((item) => item.name === "third-party-quickstart")).toBe(true);
    expect(items.some((item) => item.name === "local-marketplace")).toBe(true);
    expect(items.some((item) => item.name === "public-fleet-operator")).toBe(true);
    expect(items.some((item) => item.name === "evidence-market-flow")).toBe(true);
    expect(items.some((item) => item.name === "oracle-market-flow")).toBe(true);
  });

  it("reads bundled template readmes", () => {
    const text = readBundledTemplateReadme("local-marketplace");
    expect(text).toContain("Local Marketplace");
  });

  it("exports bundled templates to a target directory", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-template-"));
    const outputPath = path.join(tempDir, "local-marketplace");
    const result = exportBundledTemplate({
      name: "local-marketplace",
      outputPath,
    });

    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(path.join(outputPath, "host.openfox.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, "solver.openfox.json"))).toBe(true);
  });

  it("exports the public fleet operator bundle", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-template-"));
    const outputPath = path.join(tempDir, "public-fleet-operator");
    exportBundledTemplate({
      name: "public-fleet-operator",
      outputPath,
    });

    expect(fs.existsSync(path.join(outputPath, "fleet.yml"))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, "operator-notes.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(outputPath, "dashboard", "export-dashboard.sh")),
    ).toBe(true);
  });

  it("exports packaged evidence and oracle market templates", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfox-template-"));

    const evidenceOutput = path.join(tempDir, "evidence-market-flow");
    exportBundledTemplate({
      name: "evidence-market-flow",
      outputPath: evidenceOutput,
    });
    expect(fs.existsSync(path.join(evidenceOutput, "operator.openfox.json"))).toBe(true);

    const oracleOutput = path.join(tempDir, "oracle-market-flow");
    exportBundledTemplate({
      name: "oracle-market-flow",
      outputPath: oracleOutput,
    });
    expect(fs.existsSync(path.join(oracleOutput, "operator.openfox.json"))).toBe(true);
  });
});
