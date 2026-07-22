import {
  confirm,
  input,
  number as numberPrompt,
  select
} from "@inquirer/prompts";

import {
  listLocatableTargets,
  listRecorderTargets,
  type RecorderTarget
} from "../../application/recorder/locator-selector.js";
import type { PendingConfirmation } from "../../domain/generation.js";
import {
  ProposedStepSchema,
  type ProposedStep
} from "../../domain/proposed-step.js";
import type {
  GenerationPromptPort,
  ManualProposalInput
} from "../../ports/generation-prompt.js";

interface SelectConfig {
  message: string;
  choices: readonly { name: string; value: string }[];
}

interface InputConfig {
  message: string;
  validate?: ((value: string) => boolean | string) | undefined;
}

interface ConfirmConfig {
  message: string;
  default: boolean;
}

interface NumberConfig {
  message: string;
  default: number;
  min?: number | undefined;
  max?: number | undefined;
}

export interface GenerationPromptFunctions {
  select: (config: SelectConfig) => Promise<unknown>;
  input: (config: InputConfig) => Promise<unknown>;
  confirm: (config: ConfirmConfig) => Promise<unknown>;
  number: (config: NumberConfig) => Promise<unknown>;
}

export interface GenerationDiagnosticStream {
  write: (content: string) => unknown;
  isTTY?: boolean | undefined;
}

const defaultPrompts: GenerationPromptFunctions = {
  select: async (config) => select({
    message: config.message,
    choices: [...config.choices]
  }),
  input: async (config) => input({
    message: config.message,
    ...(config.validate === undefined ? {} : { validate: config.validate })
  }),
  confirm: async (config) => confirm(config),
  number: async (config) => numberPrompt(config)
};

function selectedString(value: unknown, allowed?: readonly string[]): string {
  if (
    typeof value !== "string"
    || (allowed !== undefined && !allowed.includes(value))
  ) {
    throw new Error("Prompt returned an invalid selection");
  }
  return value;
}

function selectedNumber(
  value: unknown,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error("Prompt returned an invalid number");
  }
  return value;
}

function common(input: ManualProposalInput): {
  binding: ManualProposalInput["binding"];
  activity: { before: string };
  expect?: ManualProposalInput["expect"];
} {
  return {
    binding: input.binding,
    activity: { before: input.before },
    ...(input.expect === undefined ? {} : { expect: input.expect })
  };
}

function requireTargets(targets: readonly RecorderTarget[]): void {
  if (targets.length === 0) {
    throw new Error("No deterministic Layout targets are available");
  }
}

export class InquirerGenerationPrompt implements GenerationPromptPort {
  public constructor(
    private readonly prompts: GenerationPromptFunctions = defaultPrompts,
    private readonly diagnostics: GenerationDiagnosticStream = process.stderr
  ) {}

  public async confirm(challenge: PendingConfirmation): Promise<boolean> {
    if (this.diagnostics.isTTY !== true) {
      throw new Error("Generation confirmation requires a local TTY");
    }
    if (challenge.status !== "pending") {
      throw new Error("Generation confirmation challenge is not pending");
    }
    this.diagnostics.write(
      `TapHound confirmation: ${challenge.actionSummary}\n`
    );
    const answer = await this.prompts.confirm({
      message: `Approve action at step ${String(challenge.stepIndex)}?`,
      default: false
    });
    if (typeof answer !== "boolean") {
      throw new Error("Prompt returned an invalid confirmation");
    }
    return answer;
  }

  public async buildManualProposal(
    input: ManualProposalInput
  ): Promise<ProposedStep> {
    const shared = common(input);
    if (input.action === "back" || input.action === "wait") {
      return ProposedStepSchema.parse({ action: input.action, ...shared });
    }
    if (input.action === "inputText") {
      const text = selectedString(await this.prompts.input({
        message: "Text to enter",
        validate: (answer) => answer.length > 0 || "Text must not be empty"
      }));
      return ProposedStepSchema.parse({ action: input.action, text, ...shared });
    }
    if (input.action === "scrollTo") {
      return this.buildScrollTo(input, shared);
    }

    const targets = listRecorderTargets(input.layout, input.action);
    const target = await this.selectTarget(
      targets,
      "Choose a deterministic Layout target"
    );
    if (input.action === "click") {
      return ProposedStepSchema.parse({
        action: input.action,
        locator: target.locator,
        ...shared
      });
    }
    if (input.action === "longClick") {
      const durationMs = selectedNumber(await this.prompts.number({
        message: "Long-click duration (ms)",
        default: 800,
        min: 1
      }), 1);
      return ProposedStepSchema.parse({
        action: input.action,
        locator: target.locator,
        durationMs,
        ...shared
      });
    }

    const direction = await this.selectDirection();
    const options = await this.swipeOptions();
    return ProposedStepSchema.parse({
      action: input.action,
      locator: target.locator,
      direction,
      ...options,
      ...shared
    });
  }

  private async buildScrollTo(
    input: ManualProposalInput,
    shared: ReturnType<typeof common>
  ): Promise<ProposedStep> {
    const container = await this.selectTarget(
      listRecorderTargets(input.layout, "swipe"),
      "Choose the scrollable container"
    );
    const target = await this.selectTarget(
      listLocatableTargets(input.layout),
      "Choose the scroll target"
    );
    const direction = await this.selectDirection();
    const options = await this.swipeOptions();
    const maxSwipes = selectedNumber(await this.prompts.number({
      message: "Maximum scroll swipes",
      default: 20,
      min: 1,
      max: 30
    }), 1, 30);
    return ProposedStepSchema.parse({
      action: "scrollTo",
      locator: target.locator,
      container: container.locator,
      direction,
      maxSwipes,
      ...options,
      ...shared
    });
  }

  private async selectTarget(
    targets: readonly RecorderTarget[],
    message: string
  ): Promise<RecorderTarget> {
    requireTargets(targets);
    const id = selectedString(await this.prompts.select({
      message,
      choices: targets.map((target) => ({
        name: target.label,
        value: target.element.id
      }))
    }), targets.map((target) => target.element.id));
    const target = targets.find((candidate) => candidate.element.id === id);
    if (target === undefined) {
      throw new Error("Prompt returned an invalid selection");
    }
    return target;
  }

  private async selectDirection(): Promise<
    "up" | "down" | "left" | "right"
  > {
    const directions = ["up", "down", "left", "right"] as const;
    const value = await this.prompts.select({
      message: "Swipe direction",
      choices: directions.map((direction) => ({
        name: direction,
        value: direction
      }))
    });
    return selectedString(value, directions) as typeof directions[number];
  }

  private async swipeOptions(): Promise<{
    distancePercent: number;
    durationMs: number;
  }> {
    const distancePercent = selectedNumber(await this.prompts.number({
      message: "Swipe distance (0–1)",
      default: 0.6,
      min: 0.01,
      max: 1
    }), 0.01, 1);
    const durationMs = selectedNumber(await this.prompts.number({
      message: "Swipe duration (ms)",
      default: 300,
      min: 1
    }), 1);
    return { distancePercent, durationMs };
  }
}
