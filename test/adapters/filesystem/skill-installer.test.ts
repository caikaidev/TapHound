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

    expect([...names].sort()).toEqual([
      "taphound-bug-fix",
      "taphound-case-suite",
      "taphound-flash",
      "taphound-journey-brief-author",
      "taphound-journey-generator",
      "taphound-verify-change"
    ]);
  });

  it("installs the multi-Case Suite workflow with its durable Ledger helper", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-case-suite-skill-"));
    try {
      const destination = join(target, "taphound-case-suite");
      await installer.installTo("taphound-case-suite", destination);
      const content = await readFile(join(destination, "SKILL.md"), "utf8");
      expect(content).toContain("one Case at a time");
      expect(content).toContain("case-ledger.json");
      expect(content).toContain("independent Replay");
      expect(await readdir(join(destination, "schemas")))
        .toContain("case-ledger.schema.json");
      expect(await readFile(
        join(destination, "scripts", "ledger.mjs"), "utf8"
      )).toContain("CASE_SUITE_REVISION_CONFLICT");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("installs the bug-fix workflow with its helper and templates", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-bug-fix-skill-"));
    try {
      const destination = join(target, "taphound-bug-fix");
      await installer.installTo("taphound-bug-fix", destination);
      const content = await readFile(join(destination, "SKILL.md"), "utf8");
      expect(content).toContain("no reproduction, no fix");
      expect(content).toContain("bug-tracker-reader");
      expect(content).toContain(".taphound/journeys/bugs/<caseId>.json");
      expect(await readdir(join(destination, "templates")))
        .toEqual(["bug-record.md", "fix-report.md"]);
      expect(await readFile(
        join(destination, "scripts", "bug-fix.mjs"), "utf8"
      )).toContain("TAPHOUND_BUG_READER_SKILL");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("installs the standalone flash Skill with its script and example plan", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-flash-skill-"));
    try {
      const destination = join(target, "taphound-flash");
      await installer.installTo("taphound-flash", destination);
      const content = await readFile(join(destination, "SKILL.md"), "utf8");
      expect(content).toContain("scripts/flash.mjs run");
      expect(content).toContain("taphound-verify-change");
      // Flash runs without the TapHound CLI.
      expect(content).not.toMatch(/`taphound [a-z]/);
      expect(await readdir(join(destination, "scripts"))).toContain("flash.mjs");
      expect(await readdir(join(destination, "templates")))
        .toContain("flash-plan.example.json");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("installs the public-CLI-only change verification Workflow Skill", async () => {
    const installer = new FileSystemSkillInstaller();
    const target = await mkdtemp(join(tmpdir(), "taphound-workflow-skills-"));
    try {
      const destination = join(target, "taphound-verify-change");
      await installer.installTo("taphound-verify-change", destination);
      const content = await readFile(join(destination, "SKILL.md"), "utf8");
      expect(content).toContain(".taphound/build/workflows/<caseId>/manifest.json");
      expect(content).toContain("schemas/workflow-manifest.schema.json");
      expect(content).toContain("PAUSED");
      expect(content).toContain("taphound verify");
      // Installed Skills cannot rely on TapHound's source tree.
      expect(content).not.toMatch(/src\/(domain|application|adapters)\//);
      expect(content).not.toContain("FileSystemGenerationSessionStore");

      const accept = await readFile(
        join(destination, "references", "accept.md"), "utf8"
      );
      expect(accept).toContain(
        "taphound contract --project <project> --contract <path> --json"
      );
      expect(accept).not.toContain("taphound contract validate");

      const preserve = await readFile(
        join(destination, "references", "preserve.md"), "utf8"
      );
      expect(preserve).toContain("scripts/handoff.mjs");
      expect(preserve).toContain("Large UI refactor");
      expect(await readFile(join(destination, "scripts", "handoff.mjs"), "utf8"))
        .toContain('status: "PAUSED"');
      expect(await readFile(join(destination, "scripts", "ui-refactor.mjs"), "utf8"))
        .toContain("frozen observables");
      expect(await readdir(join(destination, "schemas")))
        .toContain("workflow-manifest.schema.json");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
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

describe("Field Skills installer integration", () => {
  it("discovers only three default Field Skills", async () => {
    const installer = new FileSystemSkillInstaller();
    expect(await installer.listSkillNames("field")).toEqual([
      "tap-check", "tap-fix", "taphound-flash"
    ]);
  });

  it("copies Field Skills and shared runner with the selected profile", async () => {
    const installer = new FileSystemSkillInstaller();
    const root = await mkdtemp(join(tmpdir(), "taphound-field-install-"));
    try {
      const names = ["tap-check", "tap-fix", "taphound-flash"];
      const targets = names.map((name) => join(root, ".agents", "skills", name));
      await installer.checkConflicts("field", targets);
      for (const name of names) {
        await installer.installTo(name, join(root, ".agents", "skills", name), "field");
      }
      expect(await readFile(join(root, ".agents", "skills", "tap-check", "SKILL.md"), "utf8"))
        .toContain("3.6-copy-ready");
      expect(await readFile(join(root, ".agents", "skills", "taphound-flash", "scripts", "feedback.mjs"), "utf8"))
        .toContain("feedback");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows identical Field reinstallation but rejects a local edit before replacing it", async () => {
    const installer = new FileSystemSkillInstaller();
    const root = await mkdtemp(join(tmpdir(), "taphound-field-reinstall-"));
    try {
      const target = join(root, "tap-check");
      await installer.installTo("tap-check", target, "field");
      await installer.checkConflicts("field", [target]);
      await installer.installTo("tap-check", target, "field");
      const file = join(target, "SKILL.md");
      const fs = await import("node:fs/promises");
      await fs.appendFile(file, "\\n# Personal customization\\n");
      const modified = await readFile(file, "utf8");
      await expect(installer.checkConflicts("field", [target]))
        .rejects.toThrow("Move conflicting Skill directories");
      await expect(installer.installTo("tap-check", target, "field"))
        .rejects.toThrow("existing payload differs");
      expect(await readFile(file, "utf8")).toBe(modified);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects installed legacy Skills before writing Field files", async () => {
    const installer = new FileSystemSkillInstaller();
    const root = await mkdtemp(join(tmpdir(), "taphound-profile-conflict-"));
    try {
      const skillsRoot = join(root, ".agents", "skills");
      const old = join(skillsRoot, "taphound-verify-change");
      const fs = await import("node:fs/promises");
      await fs.mkdir(old, { recursive: true });
      await fs.writeFile(join(old, "SKILL.md"), "name: taphound-verify-change");
      await expect(installer.checkConflicts("field", [
        join(skillsRoot, "tap-check"), join(skillsRoot, "tap-fix"), join(skillsRoot, "taphound-flash")
      ])).rejects.toThrow("Move conflicting Skill directories");
      await expect(readdir(join(skillsRoot, "tap-check"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
