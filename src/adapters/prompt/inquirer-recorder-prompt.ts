import {
  confirm,
  input,
  number as numberPrompt,
  select
} from "@inquirer/prompts";

import type { BridgeScenario } from "../../domain/journey.js";
import type {
  ExternalStepAction,
  RecorderAction,
  RecorderPromptPort,
  RecorderTargetChoice,
  ScrollDecision,
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
  "scrollTo",
  "back",
  "wait",
  "bridgeTrigger",
  "finish",
  "cancel"
];

const EXTERNAL_STEP_ACTIONS: readonly ExternalStepAction[] = [
  "click",
  "longClick",
  "inputText",
  "swipe",
  "scrollTo",
  "back",
  "wait",
  "finishExternal"
];

const BRIDGE_SCENARIOS: readonly BridgeScenario[] = [
  "photoCapture",
  "pickImage",
  "pickFile",
  "custom"
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
      message: "Choose the next TapHound Action",
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
    this.diagnostics.write(`TapHound: ${message}\n`);
    return Promise.resolve();
  }

  public async selectScrollContainer(
    choices: readonly RecorderTargetChoice[]
  ): Promise<string> {
    const value = await this.prompts.select({
      message: "Choose the scrollable container",
      choices: choices.map((choice) => ({ name: choice.label, value: choice.id }))
    });
    return selectedString(value, choices.map((choice) => choice.id));
  }

  public async scrollTargetDecision(
    choices: readonly RecorderTargetChoice[]
  ): Promise<ScrollDecision> {
    const scrollMore = "__scroll_more__";
    const cancel = "__cancel__";
    const value = await this.prompts.select({
      message: "Select the target once visible, or scroll again",
      choices: [
        ...choices.map((choice) => ({ name: choice.label, value: choice.id })),
        { name: "Scroll again", value: scrollMore },
        { name: "Cancel scrollTo", value: cancel }
      ]
    });
    const selected = selectedString(value, [
      ...choices.map((choice) => choice.id),
      scrollMore,
      cancel
    ]);
    if (selected === scrollMore) {
      return { kind: "scrollMore" };
    }
    if (selected === cancel) {
      return { kind: "cancel" };
    }
    return { kind: "select", id: selected };
  }

  public async selectBridgeScenario(): Promise<BridgeScenario> {
    const value = await this.prompts.select({
      message: "Bridge scenario",
      choices: BRIDGE_SCENARIOS.map((scenario) => ({
        name: scenario,
        value: scenario
      }))
    });
    return selectedString(value, BRIDGE_SCENARIOS) as BridgeScenario;
  }

  public async inputBridgeDescription(
    scenario: BridgeScenario
  ): Promise<string> {
    const value = await this.prompts.input({
      message: `Bridge description${
        scenario === "custom" ? " (required)" : ""
      }`,
      validate: (answer) => answer.trim().length > 0 || "Description must not be empty"
    });
    return selectedString(value);
  }

  public async inputBridgeReturnTimeoutMs(): Promise<number> {
    return selectedNumber(await this.prompts.number({
      message: "Return timeout (ms)",
      default: 30000,
      min: 1
    }), 1);
  }

  public async selectExternalStepAction(): Promise<ExternalStepAction> {
    const value = await this.prompts.select({
      message: "Choose an external App Action",
      choices: EXTERNAL_STEP_ACTIONS.map((action) => ({
        name: action,
        value: action
      }))
    });
    return selectedString(value, EXTERNAL_STEP_ACTIONS) as ExternalStepAction;
  }

  public notifyExternalEscape(escapedPackageName: string): Promise<void> {
    this.diagnostics.write(
      `TapHound: Package escape detected — ${escapedPackageName}\n`
    );
    return Promise.resolve();
  }

  public notifyExternalReturn(): Promise<void> {
    this.diagnostics.write("TapHound: Returned to target package\n");
    return Promise.resolve();
  }

  public notifyBridgeNoEscape(): Promise<void> {
    this.diagnostics.write(
      "TapHound: Trigger did not cause a package escape; bridge step was not recorded\n"
    );
    return Promise.resolve();
  }
}
