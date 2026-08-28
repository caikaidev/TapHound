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

const skillsDir = join(packageRoot, "assets", "skills");

const journeySkillPath = join(skillsDir, "taphound-journey-generator");

describe("FileSystemSkillInstaller", () => {
  it("listSkillNames discovers all skill directories with SKILL.md", async () => {
    const installer = new FileSystemSkillInstaller();
    const names = await installer.listSkillNames();

    expect(names).toContain("taphound-journey-generator");
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it("installs a named skill payload to a target directory", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      await installer.installTo("taphound-journey-generator", join(target, "my-skill"));

      const copied = await readFile(
        join(target, "my-skill", "SKILL.md"),
        "utf8"
      );
      expect(copied).toContain("taphound-journey-generator");

      const promptsDir = await readdir(
        join(target, "my-skill", "prompts")
      );
      expect(promptsDir).toContain("consume-journey-brief.md");

      const schemasDir = await readdir(
        join(target, "my-skill", "schemas")
      );
      expect(schemasDir).toContain("proposed-step-envelope.json");
      expect(schemasDir).toContain("observe-output.json");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("installs the taphound-journey-brief-author skill with its merged payload", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      await installer.installTo("taphound-journey-brief-author", join(target, "my-skill"));

      const copied = await readFile(
        join(target, "my-skill", "SKILL.md"),
        "utf8"
      );
      expect(copied).toContain("taphound-journey-brief-author");

      const promptsDir = await readdir(
        join(target, "my-skill", "prompts")
      );
      expect(promptsDir).toContain("context-analyze-project.md");

      const schemasDir = await readdir(
        join(target, "my-skill", "schemas")
      );
      expect(schemasDir).toContain("project-context.json");
      expect(schemasDir).toContain("project-context-module.json");

      const templatesDir = await readdir(
        join(target, "my-skill", "templates")
      );
      expect(templatesDir).toContain("project-context.example.json");
      expect(templatesDir).toContain("project-context-module.example.json");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("skips and returns skipped=true when target equals payload", async () => {
    const installer = new FileSystemSkillInstaller();
    const result = await installer.installTo("taphound-journey-generator", journeySkillPath);
    expect(result.skipped).toBe(true);
    expect(result.targetPath).toBe(journeySkillPath);
  });

  it("overwrites existing files in the target directory", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      const targetSkill = join(target, "skill");
      await installer.installTo("taphound-journey-generator", targetSkill);
      await installer.installTo("taphound-journey-generator", targetSkill);

      const copied = await readFile(join(targetSkill, "SKILL.md"), "utf8");
      expect(copied).toContain("taphound-journey-generator");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("throws SkillPayloadMissingError for an unknown skill name", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-init-test-"));

    try {
      await expect(
        installer.installTo("nonexistent-skill", join(target, "skill"))
      ).rejects.toThrow(/Skill payload not found/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
