import { Command } from "commander";

import {
  SkillPayloadMissingError,
  NoSkillsFoundError
} from "../../adapters/filesystem/skill-installer.js";
import type { InitInput } from "../../application/init/init-service.js";
import {
  NoAgentsSelectedError,
  UnknownAgentError,
  parseAgentIds,
  type AgentId
} from "../../domain/init.js";
import {
  InitPromptCancelledError
} from "../../ports/init-prompt.js";
import type { CliDependencies } from "../dependencies.js";
import { errorMessage, writeJson, writeLine } from "../output.js";

type InitFailureCode =
  | "NO_AGENTS_SELECTED"
  | "UNKNOWN_AGENT"
  | "SKILL_PAYLOAD_MISSING"
  | "NO_SKILLS_FOUND"
  | "INTERNAL_ERROR";

interface InitOptions {
  global?: boolean | undefined;
  agent?: string | undefined;
  json?: boolean | undefined;
}

function writeInitFailure(
  dependencies: CliDependencies,
  options: InitOptions,
  exitCode: 2 | 4,
  code: InitFailureCode,
  error: unknown
): void {
  const output = {
    status: "error" as const,
    exitCode,
    failure: {
      code,
      message: errorMessage(error)
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

function writeInitSuccess(
  dependencies: CliDependencies,
  options: InitOptions,
  result: {
    status: string;
    agents: string[];
    skills: Array<{
      name: string;
      paths: string[];
      skipped?: string[] | undefined;
    }>;
  }
): void {
  if (options.json === true) {
    writeJson(dependencies.stdout, result);
  } else {
    const agentList = result.agents.join(", ");
    let message = `Installed TapHound Skills for: ${agentList}`;
    for (const skill of result.skills) {
      const pathList = skill.paths.join("\n  ");
      message += `\n  ${skill.name}:\n  ${pathList}`;
      if (skill.skipped !== undefined && skill.skipped.length > 0) {
        message += `\n  Skipped (already installed): ${skill.skipped.join(", ")}`;
      }
    }
    writeLine(dependencies.stdout, message);
  }
  dependencies.setExitCode(0);
}

export function createInitCommand(
  dependencies: CliDependencies
): Command {
  return new Command("init")
    .description("Install TapHound Skills for AI agents")
    .option("--global", "Install to user-level directories instead of project-level")
    .option("--agent <ids>", "Comma-separated agent IDs (non-interactive)")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: InitOptions): Promise<void> => {
      let agents: AgentId[];

      if (options.agent !== undefined) {
        try {
          agents = parseAgentIds(options.agent);
        } catch (error) {
          if (error instanceof UnknownAgentError) {
            writeInitFailure(dependencies, options, 2, "UNKNOWN_AGENT", error);
            return;
          }
          writeInitFailure(dependencies, options, 4, "INTERNAL_ERROR", error);
          return;
        }
        if (agents.length === 0) {
          writeInitFailure(
            dependencies,
            options,
            2,
            "NO_AGENTS_SELECTED",
            new NoAgentsSelectedError()
          );
          return;
        }
      } else {
        try {
          agents = await dependencies.initPrompt.selectAgents();
        } catch (error) {
          if (error instanceof InitPromptCancelledError) {
            writeInitFailure(
              dependencies,
              options,
              2,
              "NO_AGENTS_SELECTED",
              error
            );
            return;
          }
          if (error instanceof Error && error.message.includes("TTY")) {
            writeInitFailure(
              dependencies,
              options,
              2,
              "NO_AGENTS_SELECTED",
              new NoAgentsSelectedError()
            );
            return;
          }
          writeInitFailure(dependencies, options, 4, "INTERNAL_ERROR", error);
          return;
        }
        if (agents.length === 0) {
          writeInitFailure(
            dependencies,
            options,
            2,
            "NO_AGENTS_SELECTED",
            new NoAgentsSelectedError()
          );
          return;
        }
      }

      const input: InitInput = {
        agents,
        global: options.global === true
      };

      try {
        const result = await dependencies.init.install(input);
        writeInitSuccess(dependencies, options, result);
      } catch (error) {
        if (error instanceof SkillPayloadMissingError) {
          writeInitFailure(
            dependencies,
            options,
            2,
            "SKILL_PAYLOAD_MISSING",
            error
          );
          return;
        }
        if (error instanceof NoSkillsFoundError) {
          writeInitFailure(
            dependencies,
            options,
            2,
            "NO_SKILLS_FOUND",
            error
          );
          return;
        }
        if (error instanceof NoAgentsSelectedError) {
          writeInitFailure(
            dependencies,
            options,
            2,
            "NO_AGENTS_SELECTED",
            error
          );
          return;
        }
        writeInitFailure(dependencies, options, 4, "INTERNAL_ERROR", error);
      }
    });
}
