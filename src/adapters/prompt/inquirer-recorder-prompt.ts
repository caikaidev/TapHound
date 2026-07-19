import {
  confirm,
  input,
  number as numberPrompt,
  select
} from "@inquirer/prompts";

import type {
  RecorderAction,
  RecorderPromptPort,
  RecorderTargetChoice,
  SwipeOptions
} from "../../ports/recorder-prompt.js";

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

export interface PromptFunctions {
  select: (config: SelectConfig) => Promise<unknown>;
  input: (config: InputConfig) => Promise<unknown>;
  confirm: (config: ConfirmConfig) => Promise<unknown>;
  number: (config: NumberConfig) => Promise<unknown>;
}

export interface DiagnosticStream {
  write: (content: string) => unknown;
}

const defaultPrompts: PromptFunctions = {
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

const ACTIONS: readonly RecorderAction[] = [
  "click",
  "longClick",
  "inputText",
  "swipe",
  "back",
  "wait",
  "finish",
  "cancel"
];

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

export class InquirerRecorderPrompt implements RecorderPromptPort {
  public constructor(
    private readonly prompts: PromptFunctions = defaultPrompts,
    private readonly diagnostics: DiagnosticStream = process.stderr
  ) {}

  public async selectAction(): Promise<RecorderAction> {
    const value = await this.prompts.select({
      message: "Choose the next APR Action",
      choices: ACTIONS.map((action) => ({ name: action, value: action }))
    });
    return selectedString(value, ACTIONS) as RecorderAction;
  }

  public async selectTarget(
    choices: readonly RecorderTargetChoice[]
  ): Promise<string> {
    const value = await this.prompts.select({
      message: "Choose a Layout target",
      choices: choices.map((choice) => ({
        name: choice.label,
        value: choice.id
      }))
    });
    return selectedString(value, choices.map((choice) => choice.id));
  }

  public async inputText(): Promise<string> {
    const value = await this.prompts.input({
      message: "Text to enter",
      validate: (answer) => answer.length > 0 || "Text must not be empty"
    });
    return selectedString(value);
  }

  public async selectSwipeDirection(): Promise<"up" | "down" | "left" | "right"> {
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

  public async longClickDuration(): Promise<number> {
    return selectedNumber(await this.prompts.number({
      message: "Long-click duration (ms)",
      default: 800,
      min: 1
    }), 1);
  }

  public async swipeOptions(): Promise<SwipeOptions> {
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

  public async selectFallbackLabel(
    annotatedScreenshotPath: string
  ): Promise<string | undefined> {
    const enabled = await this.prompts.confirm({
      message: `Add annotated-label fallback from ${annotatedScreenshotPath}?`,
      default: false
    });
    if (enabled !== true) {
      return undefined;
    }
    const label = await this.prompts.input({
      message: "Android CLI annotated label",
      validate: (value) => /^#\d+$/.test(value) || "Use the #number format"
    });
    const selected = selectedString(label);
    if (!/^#\d+$/.test(selected)) {
      throw new Error("Fallback label must use the #number format");
    }
    return selected;
  }

  public notifyFailure(message: string): Promise<void> {
    this.diagnostics.write(`APR: ${message}\n`);
    return Promise.resolve();
  }
}
