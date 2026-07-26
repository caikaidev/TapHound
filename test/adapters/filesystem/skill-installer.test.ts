import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileSystemSkillInstaller } from "../../../src/adapters/filesystem/skill-installer.js";

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const payloadPath = join(
  packageRoot,
  "assets",
  "skills",
  "taphound-ai-journey"
);

describe("FileSystemSkillInstaller", () => {
  it("finds the packaged skill payload", async () => {
    const installer = new FileSystemSkillInstaller();
    const found = await installer.findPayload();
    expect(found).toBe(payloadPath);
  });

  it("copies the full payload tree to a target directory", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      await installer.installTo(join(target, "my-skill"));

      const copied = await readFile(
        join(target, "my-skill", "SKILL.md"),
        "utf8"
      );
      expect(copied).toContain("taphound-ai-journey");

      const promptsDir = await readdir(
        join(target, "my-skill", "prompts")
      );
      expect(promptsDir).toContain("analyze-project.md");

      const schemasDir = await readdir(
        join(target, "my-skill", "schemas")
      );
      expect(schemasDir).toContain("project-context.json");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("skips and returns skipped=true when target equals payload", async () => {
    const installer = new FileSystemSkillInstaller();
    const result = await installer.installTo(payloadPath);
    expect(result.skipped).toBe(true);
    expect(result.targetPath).toBe(payloadPath);
  });

  it("overwrites existing files in the target directory", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      const targetSkill = join(target, "skill");
      await installer.installTo(targetSkill);
      await installer.installTo(targetSkill);

      const copied = await readFile(join(targetSkill, "SKILL.md"), "utf8");
      expect(copied).toContain("taphound-ai-journey");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
