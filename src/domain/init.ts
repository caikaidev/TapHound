import { resolve } from "node:path";

import { z } from "zod";

export const SKILL_DIRECTORY_NAME = "taphound-ai-journey";

export const AGENT_IDS = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "other"
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AgentIdSchema = z.enum(AGENT_IDS);

export interface AgentDefinition {
  readonly id: AgentId;
  readonly label: string;
  readonly projectPath: string;
  readonly globalPath: string;
}

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    projectPath: ".claude/skills",
    globalPath: ".claude/skills"
  },
  {
    id: "codex",
    label: "Codex",
    projectPath: ".agents/skills",
    globalPath: ".agents/skills"
  },
  {
    id: "cursor",
    label: "Cursor",
    projectPath: ".cursor/skills",
    globalPath: ".cursor/skills"
  },
  {
    id: "droid",
    label: "Droid",
    projectPath: ".factory/skills",
    globalPath: ".factory/skills"
  },
  {
    id: "other",
    label: "Other (standard .agents)",
    projectPath: ".agents/skills",
    globalPath: ".agents/skills"
  }
];

export function findAgentDefinition(id: AgentId): AgentDefinition {
  const definition = AGENT_REGISTRY.find((agent) => agent.id === id);
  if (definition === undefined) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return definition;
}

export function parseAgentIds(raw: string): AgentId[] {
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const result: AgentId[] = [];
  for (const id of ids) {
    const parsed = AgentIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new UnknownAgentError(id);
    }
    result.push(parsed.data);
  }
  return result;
}

export class UnknownAgentError extends Error {
  public constructor(public readonly agentId: string) {
    super(`Unknown agent: ${agentId}`);
    this.name = "UnknownAgentError";
  }
}

export class NoAgentsSelectedError extends Error {
  public constructor() {
    super("At least one agent must be selected");
    this.name = "NoAgentsSelectedError";
  }
}

export interface TargetPath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly agents: AgentId[];
  readonly skipped: boolean;
}

export function resolveTargetPaths(
  agents: readonly AgentId[],
  global: boolean,
  cwd: string,
  homedir: string
): TargetPath[] {
  if (agents.length === 0) {
    throw new NoAgentsSelectedError();
  }

  const map = new Map<string, { relativePath: string; agents: AgentId[] }>();

  for (const id of agents) {
    const definition = findAgentDefinition(id);
    const baseDir = global ? definition.globalPath : definition.projectPath;
    const relativePath = `${baseDir}/${SKILL_DIRECTORY_NAME}`;
    const absolutePath = resolve(
      global ? homedir : cwd,
      relativePath
    );

    const existing = map.get(absolutePath);
    if (existing === undefined) {
      map.set(absolutePath, {
        relativePath,
        agents: [id]
      });
    } else {
      existing.agents.push(id);
    }
  }

  return [...map.entries()].map(([absolutePath, entry]) => ({
    absolutePath,
    relativePath: entry.relativePath,
    agents: entry.agents,
    skipped: false
  }));
}

export const InitResultSchema = z.strictObject({
  status: z.literal("installed"),
  exitCode: z.literal(0),
  agents: z.array(z.string()),
  paths: z.array(z.string()),
  skipped: z.array(z.string()).optional()
});

export type InitResult = z.infer<typeof InitResultSchema>;
