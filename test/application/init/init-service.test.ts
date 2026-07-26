import { describe, expect, it, vi } from "vitest";

import { InitService } from "../../../src/application/init/init-service.js";
import { NoAgentsSelectedError } from "../../../src/domain/init.js";
import type {
  SkillInstallResult,
  SkillInstallerPort
} from "../../../src/ports/skill-installer.js";

function createFakeInstaller(
  results?: Map<string, SkillInstallResult>
): SkillInstallerPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findPayload: vi.fn(() => Promise.resolve("/payload/taphound-ai-journey")),
    installTo: vi.fn((targetDir: string): Promise<SkillInstallResult> => {
      calls.push(targetDir);
      const override = results?.get(targetDir);
      if (override !== undefined) {
        return Promise.resolve(override);
      }
      return Promise.resolve({ targetPath: targetDir, skipped: false });
    })
  };
}

describe("InitService", () => {
  it("installs to each unique target path and returns the result", async () => {
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
    expect(result.paths).toHaveLength(2);
    expect(result.paths).toContain(".claude/skills/taphound-ai-journey");
    expect(result.paths).toContain(".factory/skills/taphound-ai-journey");
    expect(installer.calls).toHaveLength(2);
  });

  it("deduplicates codex and other to a single install call", async () => {
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

    expect(installer.calls).toHaveLength(1);
    expect(result.agents).toEqual(["codex", "other"]);
    expect(result.paths).toEqual([".agents/skills/taphound-ai-journey"]);
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
      "/home/.claude/skills/taphound-ai-journey"
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

  it("reports skipped paths when installer returns skipped", async () => {
    const projectPath = "/project/.factory/skills/taphound-ai-journey";
    const installer = createFakeInstaller(
      new Map([[projectPath, {
        targetPath: projectPath,
        skipped: true
      }]])
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

    expect(result.paths).toEqual([".claude/skills/taphound-ai-journey"]);
    expect(result.skipped).toEqual([".factory/skills/taphound-ai-journey"]);
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

    expect(result.skipped).toBeUndefined();
  });
});
