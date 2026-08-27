import { homedir } from "node:os";

import {
  NoAgentsSelectedError,
  resolveTargetPaths,
  type AgentId,
  type InitResult,
  type SkillInstallGroup
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

    const skillNames = await this.deps.installer.listSkillNames();

    const targets = resolveTargetPaths(
      skillNames,
      input.agents,
      input.global,
      this.deps.cwd,
      this.deps.homedir
    );

    const groupMap = new Map<string, SkillInstallGroup>();

    for (const target of targets) {
      const result = await this.deps.installer.installTo(
        target.skillName,
        target.absolutePath
      );

      let group = groupMap.get(target.skillName);
      if (group === undefined) {
        group = { name: target.skillName, paths: [], skipped: [] };
        groupMap.set(target.skillName, group);
      }

      if (result.skipped) {
        group.skipped.push(target.relativePath);
      } else {
        group.paths.push(target.relativePath);
      }
    }

    const allAgents: string[] = [];
    for (const target of targets) {
      for (const agent of target.agents) {
        if (!allAgents.includes(agent)) {
          allAgents.push(agent);
        }
      }
    }

    const skills = [...groupMap.values()].map((group) => {
      const skill: { name: string; paths: string[]; skipped?: string[] } = {
        name: group.name,
        paths: group.paths
      };
      if (group.skipped.length > 0) {
        skill.skipped = group.skipped;
      }
      return skill;
    });

    return {
      status: "installed",
      exitCode: 0,
      agents: allAgents,
      skills
    };
  }
}

export function defaultHomedir(): string {
  return homedir();
}
