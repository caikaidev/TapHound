import { homedir } from "node:os";

import {
  NoAgentsSelectedError,
  resolveTargetPaths,
  type AgentId,
  type InitResult
} from "../../domain/init.js";
import type { SkillInstallerPort } from "../../ports/skill-installer.js";

export interface InitServiceDeps {
  installer: SkillInstallerPort;
  cwd: string;
  homedir: string;
}

export interface InitInput {
  agents: readonly AgentId[];
  global: boolean;
}

export class InitService {
  public constructor(private readonly deps: InitServiceDeps) {}

  public async install(input: InitInput): Promise<InitResult> {
    if (input.agents.length === 0) {
      throw new NoAgentsSelectedError();
    }

    const targets = resolveTargetPaths(
      input.agents,
      input.global,
      this.deps.cwd,
      this.deps.homedir
    );

    const installedPaths: string[] = [];
    const skippedPaths: string[] = [];
    const allAgents: string[] = [];

    for (const target of targets) {
      const result = await this.deps.installer.installTo(target.absolutePath);
      if (result.skipped) {
        skippedPaths.push(target.relativePath);
      } else {
        installedPaths.push(target.relativePath);
      }
      for (const agent of target.agents) {
        if (!allAgents.includes(agent)) {
          allAgents.push(agent);
        }
      }
    }

    const result: InitResult = {
      status: "installed",
      exitCode: 0,
      agents: allAgents,
      paths: installedPaths
    };
    if (skippedPaths.length > 0) {
      return { ...result, skipped: skippedPaths };
    }
    return result;
  }
}

export function defaultHomedir(): string {
  return homedir();
}
