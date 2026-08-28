import { describe, expect, it, vi } from "vitest";

import { InitService } from "../../../src/application/init/init-service.js";
import { NoAgentsSelectedError } from "../../../src/domain/init.js";
import type {
  SkillInstallResult,
  SkillInstallerPort
} from "../../../src/ports/skill-installer.js";

const SKILL_NAMES = ["taphound-journey-generator", "taphound-journey-brief-author"];

function createFakeInstaller(
  results?: Map<string, SkillInstallResult>
): SkillInstallerPort & { calls: Array<{ skillName: string; targetDir: string }> } {
  const calls: Array<{ skillName: string; targetDir: string }> = [];
  return {
    calls,
    listSkillNames: vi.fn(() => Promise.resolve(SKILL_NAMES)),
    installTo: vi.fn(
      (skillName: string, targetDir: string): Promise<SkillInstallResult> => {
        calls.push({ skillName, targetDir });
        const override = results?.get(targetDir);
        if (override !== undefined) {
          return Promise.resolve(override);
        }
        return Promise.resolve({ targetPath: targetDir, skipped: false });
      }
    )
  };
}

describe("InitService", () => {
  it("installs all skills to each unique target path and returns the result", async () => {
    const installer = createFakeInstaller();
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    const result = await service.install({
      agents: ["claude", "droid"],
      global: false
    });

    expect(result.status).toBe("installed");
    expect(result.exitCode).toBe(0);
    expect(result.agents).toEqual(["claude", "droid"]);
    expect(result.skills).toHaveLength(2);

    const journeySkill = result.skills.find(
      (s) => s.name === "taphound-journey-generator"
    );
    expect(journeySkill?.paths).toContain(".claude/skills/taphound-journey-generator");
    expect(journeySkill?.paths).toContain(".factory/skills/taphound-journey-generator");

    const briefSkill = result.skills.find(
      (s) => s.name === "taphound-journey-brief-author"
    );
    expect(briefSkill?.paths).toContain(".claude/skills/taphound-journey-brief-author");
    expect(briefSkill?.paths).toContain(".factory/skills/taphound-journey-brief-author");

    // 2 skills x 2 agents = 4 install calls
    expect(installer.calls).toHaveLength(4);
  });

  it("deduplicates codex and other to a single install call per skill", async () => {
    const installer = createFakeInstaller();
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    const result = await service.install({
      agents: ["codex", "other"],
      global: false
    });

    // 2 skills x 1 deduplicated path = 2 install calls
    expect(installer.calls).toHaveLength(2);
    expect(result.agents).toEqual(["codex", "other"]);
    expect(result.skills).toHaveLength(2);
    for (const skill of result.skills) {
      expect(skill.paths).toEqual([`.agents/skills/${skill.name}`]);
    }
  });

  it("uses homedir for global installs", async () => {
    const installer = createFakeInstaller();
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    await service.install({
      agents: ["claude"],
      global: true
    });

    expect(installer.calls).toEqual([
      { skillName: "taphound-journey-generator", targetDir: "/home/.claude/skills/taphound-journey-generator" },
      { skillName: "taphound-journey-brief-author", targetDir: "/home/.claude/skills/taphound-journey-brief-author" }
    ]);
  });

  it("throws NoAgentsSelectedError for empty agents", async () => {
    const installer = createFakeInstaller();
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    await expect(service.install({ agents: [], global: false }))
      .rejects.toThrow(NoAgentsSelectedError);
    expect(installer.calls).toHaveLength(0);
  });

  it("reports skipped paths per skill when installer returns skipped", async () => {
    const factoryJourneyPath = "/project/.factory/skills/taphound-journey-generator";
    const claudeBriefPath = "/project/.claude/skills/taphound-journey-brief-author";
    const installer = createFakeInstaller(
      new Map([
        [factoryJourneyPath, { targetPath: factoryJourneyPath, skipped: true }],
        [claudeBriefPath, { targetPath: claudeBriefPath, skipped: true }]
      ])
    );
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    const result = await service.install({
      agents: ["claude", "droid"],
      global: false
    });

    const journeySkill = result.skills.find(
      (s) => s.name === "taphound-journey-generator"
    );
    expect(journeySkill?.paths).toEqual([".claude/skills/taphound-journey-generator"]);
    expect(journeySkill?.skipped).toEqual([".factory/skills/taphound-journey-generator"]);

    const briefSkill = result.skills.find(
      (s) => s.name === "taphound-journey-brief-author"
    );
    expect(briefSkill?.paths).toEqual([".factory/skills/taphound-journey-brief-author"]);
    expect(briefSkill?.skipped).toEqual([".claude/skills/taphound-journey-brief-author"]);
  });

  it("does not include skipped key when nothing is skipped", async () => {
    const installer = createFakeInstaller();
    const service = new InitService({
      installer,
      cwd: "/project",
      homedir: "/home"
    });

    const result = await service.install({
      agents: ["claude"],
      global: false
    });

    for (const skill of result.skills) {
      expect(skill.skipped).toBeUndefined();
    }
  });
});
