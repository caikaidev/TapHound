import { checkbox } from "@inquirer/prompts";

import {
  AGENT_REGISTRY,
  type AgentId
} from "../../domain/init.js";
import type { InitPromptPort } from "../../ports/init-prompt.js";
import { InitPromptCancelledError } from "../../ports/init-prompt.js";

export type InitInputStream = NodeJS.ReadableStream & {
  isTTY?: boolean | undefined;
};

export type InitDiagnosticStream = NodeJS.WritableStream & {
  isTTY?: boolean | undefined;
};

export type InitPromptContext = NonNullable<
  Parameters<typeof checkbox>[1]
>;

export interface CheckboxConfig {
  message: string;
  choices: readonly {
    name: string;
    value: string;
    checked?: boolean;
  }[];
  validate?: ((
    choices: readonly { value: string }[]
  ) => boolean | string) | undefined;
}

export interface InitPromptFunctions {
  checkbox: (
    config: CheckboxConfig,
    context: InitPromptContext
  ) => Promise<string[]>;
}

const defaultPrompts: InitPromptFunctions = {
  checkbox: async (config, context) => checkbox({
    message: config.message,
    choices: [...config.choices],
    ...(config.validate === undefined
      ? {}
      : { validate: config.validate })
  }, context)
};

export class InquirerInitPrompt implements InitPromptPort {
  public constructor(
    private readonly prompts: InitPromptFunctions = defaultPrompts,
    private readonly promptInput: InitInputStream = process.stdin,
    private readonly diagnostics: InitDiagnosticStream = process.stderr
  ) {}

  public async selectAgents(): Promise<AgentId[]> {
    this.assertLocalTty();
    try {
      const selected = await this.prompts.checkbox(
        {
          message: "Select AI agents to install the TapHound Skill for:",
          choices: AGENT_REGISTRY.map((agent) => ({
            name: agent.label,
            value: agent.id
          })),
          validate: (choices) => (
            choices.length > 0
              ? true
              : "Select at least one agent"
          )
        },
        {
          input: this.promptInput,
          output: this.diagnostics
        }
      );
      return selected as AgentId[];
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.name === "AbortPromptError"
          || error.name === "ExitPromptError"
        )
      ) {
        throw new InitPromptCancelledError();
      }
      throw error;
    }
  }

  private assertLocalTty(): void {
    if (
      this.promptInput.isTTY !== true
      || this.diagnostics.isTTY !== true
    ) {
      throw new Error("Agent selection requires local TTY input and output");
    }
  }
}
