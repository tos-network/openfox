/**
 * SKILL.md Parser
 *
 * Parses SKILL.md files with YAML frontmatter + Markdown body into structured
 * skill definitions. This parser intentionally supports a richer frontmatter
 * subset so OpenFox can move closer to the OpenClaw skill catalog shape.
 */

import { parse as parseYaml } from "yaml";
import type { SkillFrontmatter, Skill, SkillSource } from "../types.js";

/**
 * Parse a SKILL.md file content into frontmatter + body.
 * Handles YAML frontmatter delimited by --- markers.
 */
export function parseSkillMd(
  content: string,
  filePath: string,
  source: SkillSource = "bundled",
): Skill | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    // No frontmatter -- treat entire content as instructions
    // with a name derived from the directory
    const name = extractNameFromPath(filePath);
    return {
      name,
      description: "",
      autoActivate: true,
      instructions: trimmed,
      source,
      path: filePath,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterRaw = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  // Parse YAML frontmatter manually (avoid requiring gray-matter at runtime)
  const frontmatter = parseYamlFrontmatter(frontmatterRaw);
  if (!frontmatter) {
    return null;
  }

  return {
    name: frontmatter.name || extractNameFromPath(filePath),
    description: frontmatter.description || "",
    autoActivate: frontmatter["auto-activate"] !== false,
    always: frontmatter.always === true,
    homepage: frontmatter.homepage,
    primaryEnv: frontmatter["primary-env"],
    requires: frontmatter.requires,
    install: frontmatter.install,
    instructions: body,
    source,
    path: filePath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
}

function parseYamlFrontmatter(raw: string): SkillFrontmatter | null {
  try {
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SkillFrontmatter;
  } catch {
    return null;
  }
}

function extractNameFromPath(filePath: string): string {
  // Extract skill name from path like ~/.openfox/skills/web-scraper/SKILL.md
  const parts = filePath.split("/");
  const skillMdIndex = parts.findIndex(
    (p) => p.toLowerCase() === "skill.md",
  );
  if (skillMdIndex > 0) {
    return parts[skillMdIndex - 1];
  }
  return parts[parts.length - 1].replace(/\.md$/i, "");
}
