import { resolve } from "node:path";

import { ContractLoader } from "../contract/contract-loader.js";
import {
  PlaybookDefinitionSchema,
  type EscalationRule,
  type PlaybookDefinition
} from "../../domain/playbook.js";

export interface PlaybookValidatorDependencies {
  readText: (path: string) => Promise<string>;
}

export interface PlaybookValidateIssue {
  id: string;
  ok: boolean;
  issues: string[];
}

export interface PlaybookValidateOutput {
  status: "valid" | "invalid";
  playbooks: PlaybookValidateIssue[];
}

export class PlaybookValidator {
  private readonly loader: ContractLoader;

  public constructor(
    private readonly dependencies: PlaybookValidatorDependencies
  ) {
    this.loader = new ContractLoader({
      readText: dependencies.readText
    });
  }

  private readonly validateRule = (rule: EscalationRule): string[] => {
    const issues: string[] = [];
    if (
      rule.then.action === "escalate"
      && rule.then.target === "semantic"
      && rule.when.verdicts?.includes("pass")
    ) {
      issues.push(
        `Rule "${rule.id}" escalates a deterministic pass to semantic comparison; use verdict needsReview instead`
      );
    }
    return issues;
  };

  private readonly verify = async (
    playbook: PlaybookDefinition,
    projectRoot: string
  ): Promise<string[]> => {
    const issues: string[] = [];
    const contractPath = resolve(
      projectRoot,
      playbook.contract.path
    );
    try {
      const loaded = await this.loader.load({
        projectRoot,
        contractPath
      });
      if (loaded.contractSha256 !== playbook.contract.sha256) {
        issues.push(
          `Bound Contract ${playbook.contract.path} drifted: binding ${playbook.contract.sha256}, found ${loaded.contractSha256}`
        );
      }
    } catch (error) {
      issues.push(
        `Bound Contract cannot be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    for (const rule of playbook.escalation.rules) {
      issues.push(...this.validateRule(rule));
    }
    return issues;
  };

  public readonly validate = async (input: {
    projectRoot: string;
    playbookPaths: readonly string[];
  }): Promise<PlaybookValidateOutput> => {
    const playbooks: PlaybookValidateIssue[] = [];
    for (const playbookPath of input.playbookPaths) {
      let id = playbookPath;
      let issues: string[];
      try {
        const text = await this.dependencies.readText(playbookPath);
        const playbook = PlaybookDefinitionSchema.parse(JSON.parse(text));
        id = playbook.id;
        issues = await this.verify(playbook, input.projectRoot);
      } catch (error) {
        issues = [
          error instanceof Error ? error.message : String(error)
        ];
      }
      playbooks.push({ id, ok: issues.length === 0, issues });
    }
    return {
      status: playbooks.every((playbook) => playbook.ok)
        ? "valid"
        : "invalid",
      playbooks
    };
  };
}