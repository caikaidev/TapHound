import { describe, expect, it } from "vitest";

import {
  AGENT_IDS,
  AGENT_REGISTRY,
  NoAgentsSelectedError,
  SKILL_DIRECTORY_NAME,
  UnknownAgentError,
  findAgentDefinition,
  parseAgentIds,
  resolveTargetPaths
} from "../../src/domain/init.js";

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

  it("uses taphound-ai-journey as the skill directory name", () => {
    expect(SKILL_DIRECTORY_NAME).toBe("taphound-ai-journey");
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
    it("maps each agent to its project-level path", () => {
      const targets = resolveTargetPaths(
        ["claude", "cursor", "droid"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(3);
      const paths = targets.map((t) => t.relativePath);
      expect(paths).toContain(".claude/skills/taphound-ai-journey");
      expect(paths).toContain(".cursor/skills/taphound-ai-journey");
      expect(paths).toContain(".factory/skills/taphound-ai-journey");
    });

    it("maps each agent to its global path when global is true", () => {
      const targets = resolveTargetPaths(
        ["claude", "droid"],
        true,
        "/project",
        "/home"
      );

      const absolutePaths = targets.map((t) => t.absolutePath);
      expect(absolutePaths).toContain("/home/.claude/skills/taphound-ai-journey");
      expect(absolutePaths).toContain("/home/.factory/skills/taphound-ai-journey");
    });

    it("deduplicates codex and other to the same .agents/skills path", () => {
      const targets = resolveTargetPaths(
        ["codex", "other"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(1);
      expect(targets[0]?.agents).toEqual(["codex", "other"]);
      expect(targets[0]?.relativePath).toBe(".agents/skills/taphound-ai-journey");
    });

    it("deduplicates when codex and other are both selected alongside others", () => {
      const targets = resolveTargetPaths(
        ["claude", "codex", "other", "droid"],
        false,
        "/project",
        "/home"
      );

      expect(targets).toHaveLength(3);
      const agentsPath = targets.find(
        (t) => t.relativePath === ".agents/skills/taphound-ai-journey"
      );
      expect(agentsPath?.agents).toEqual(["codex", "other"]);
    });

    it("throws NoAgentsSelectedError for an empty agent list", () => {
      expect(() => resolveTargetPaths([], false, "/project", "/home"))
        .toThrow(NoAgentsSelectedError);
    });

    it("produces absolute paths resolved from cwd for project-level", () => {
      const [target] = resolveTargetPaths(
        ["claude"],
        false,
        "/project",
        "/home"
      );

      expect(target?.absolutePath).toBe(
        "/project/.claude/skills/taphound-ai-journey"
      );
    });

    it("produces absolute paths resolved from homedir for global", () => {
      const [target] = resolveTargetPaths(
        ["claude"],
        true,
        "/project",
        "/home"
      );

      expect(target?.absolutePath).toBe(
        "/home/.claude/skills/taphound-ai-journey"
      );
    });

    it("marks all targets as not skipped", () => {
      const targets = resolveTargetPaths(
        ["claude", "droid"],
        false,
        "/project",
        "/home"
      );

      for (const target of targets) {
        expect(target.skipped).toBe(false);
      }
    });
  });
});
