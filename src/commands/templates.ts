import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface BundledTemplateInfo {
  name: string;
  path: string;
  hasReadme: boolean;
  description: string | null;
}

function getTemplateRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");
}

function extractDescription(readmePath: string): string | null {
  if (!fs.existsSync(readmePath)) return null;
  const lines = fs.readFileSync(readmePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

export function listBundledTemplates(): BundledTemplateInfo[] {
  const root = getTemplateRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const templatePath = path.join(root, entry.name);
      const readmePath = path.join(templatePath, "README.md");
      return {
        name: entry.name,
        path: templatePath,
        hasReadme: fs.existsSync(readmePath),
        description: extractDescription(readmePath),
      };
    });
}

export function readBundledTemplateReadme(name: string): string {
  const root = getTemplateRoot();
  const readmePath = path.join(root, name, "README.md");
  if (!fs.existsSync(readmePath)) {
    throw new Error(`Bundled template README not found: ${name}`);
  }
  return fs.readFileSync(readmePath, "utf8");
}

export function exportBundledTemplate(params: {
  name: string;
  outputPath: string;
  force?: boolean;
}): {
  name: string;
  sourcePath: string;
  outputPath: string;
} {
  const root = getTemplateRoot();
  const sourcePath = path.join(root, params.name);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Unknown bundled template: ${params.name}`);
  }
  const outputPath = path.resolve(params.outputPath);
  if (fs.existsSync(outputPath)) {
    if (!params.force) {
      throw new Error(
        `Output path already exists: ${outputPath}. Re-run with --force to overwrite.`,
      );
    }
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.cpSync(sourcePath, outputPath, { recursive: true });
  return {
    name: params.name,
    sourcePath,
    outputPath,
  };
}
