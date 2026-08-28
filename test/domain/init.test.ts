import { describe, expect, it } from "vitest";

import {
  AGENT_IDS,
  AGENT_REGISTRY,
  NoAgentsSelectedError,
  UnknownAgentError,
  findAgentDefinition,
  parseAgentIds,
  resolveTargetPaths
} from "../../src/domain/init.js";

const SKILL_NAMES = ["taphound-journey-generator", "taphound-journey-brief-author"];

describe("init domain", () => {
  it("exports five agent IDs in stable order", () => {
    expect(AGENT_IDS).toEqual([
      "claude",
      "codex",
      "cursor",
      "droid",
      "other"
    ]);
  });

  it("exports a registry with matching labels and paths", () => {
    expect(AGENT_REGISTRY).toHaveLength(5);
    for (const agent of AGENT_REGISTRY) {
      expect(findAgentDefinition(agent.id)).toBe(agent);
    }
  });

  describe("parseAgentIds", () => {
    it("parses a comma-separated string into agent IDs", () => {
      expect(parseAgentIds("claude,codex,droid")).toEqual([
        "claude",
        "codex",
        "droid"
      ]);
    });

    it("trims whitespace around entries", () => {
      expect(parseAgentIds(" claude , codex ")).toEqual(["claude", "codex"]);
    });

    it("filters empty entries", () => {
      expect(parseAgentIds("claude,,codex,")).toEqual(["claude", "codex"]);
    });

    it("throws UnknownAgentError for an unknown agent", () => {
      expect(() => parseAgentIds("claude,unknown"))
        .toThrow(UnknownAgentError);
    });
  });

  describe("resolveTargetPaths", () => {
    it("maps each skill x agent to its project-level path", () => {
      const targets = resolveTargetPaths(
        SKILL_NAMES,
        ["claude", "cursor", "droid"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(6);
      const paths = targets.map((t) => t.relativePath);
      for (const skillName of SKILL_NAMES) {
        expect(paths).toContain(`.claude/skills/${skillName}`);
        expect(paths).toContain(`.cursor/skills/${skillName}`);
        expect(paths).toContain(`.factory/skills/${skillName}`);
      }
    });

    it("maps each skill x agent to its global path when global is true", () => {
      const targets = resolveTargetPaths(
        SKILL_NAMES,
        ["claude", "droid"],
        true,
        "/project",
        "/home"
      );

      const absolutePaths = targets.map((t) => t.absolutePath);
      for (const skillName of SKILL_NAMES) {
        expect(absolutePaths).toContain(`/home/.claude/skills/${skillName}`);
        expect(absolutePaths).toContain(`/home/.factory/skills/${skillName}`);
      }
    });

    it("deduplicates codex and other to the same .agents/skills path per skill", () => {
      const targets = resolveTargetPaths(
        SKILL_NAMES,
        ["codex", "other"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(2);
      for (const skillName of SKILL_NAMES) {
        const target = targets.find(
          (t) => t.relativePath === `.agents/skills/${skillName}`
        );
        expect(target).toBeDefined();
        expect(target?.agents).toEqual(["codex", "other"]);
        expect(target?.skillName).toBe(skillName);
      }
    });

    it("deduplicates when codex and other are both selected alongside others", () => {
      const targets = resolveTargetPaths(
        ["taphound-journey-generator"],
        ["claude", "codex", "other", "droid"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(3);
      const agentsPath = targets.find(
        (t) => t.relativePath === ".agents/skills/taphound-journey-generator"
      );
      expect(agentsPath?.agents).toEqual(["codex", "other"]);
    });

    it("throws NoAgentsSelectedError for an empty agent list", () => {
      expect(() => resolveTargetPaths(SKILL_NAMES, [], false, "/project", "/home"))
        .toThrow(NoAgentsSelectedError);
    });

    it("produces absolute paths resolved from cwd for project-level", () => {
      const [target] = resolveTargetPaths(
        ["taphound-journey-generator"],
        ["claude"],
        false,
        "/project",
        "/home"
      );

      expect(target?.absolutePath).toBe(
        "/project/.claude/skills/taphound-journey-generator"
      );
    });

    it("produces absolute paths resolved from homedir for global", () => {
      const [target] = resolveTargetPaths(
        ["taphound-journey-generator"],
        ["claude"],
        true,
        "/project",
        "/home"
      );

      expect(target?.absolutePath).toBe(
        "/home/.claude/skills/taphound-journey-generator"
      );
    });

    it("marks all targets as not skipped", () => {
      const targets = resolveTargetPaths(
        ["taphound-journey-generator"],
        ["claude", "droid"],
        false,
        "/project",
        "/home"
      );

      for (const target of targets) {
        expect(target.skipped).toBe(false);
      }
    });

    it("carries skillName on each target", () => {
      const targets = resolveTargetPaths(
        SKILL_NAMES,
        ["claude"],
        false,
        "/project",
        "/home"
      );

      const skillNames = targets.map((t) => t.skillName);
      expect(skillNames).toContain("taphound-journey-generator");
      expect(skillNames).toContain("taphound-journey-brief-author");
    });
  });
});
