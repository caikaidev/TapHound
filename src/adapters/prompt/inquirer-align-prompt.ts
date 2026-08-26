import { confirm } from "@inquirer/prompts";

import {
  AlignPromptCancelledError,
  type AlignPromptPort
} from "../../ports/align-prompt.js";
import type { CameraProbeResult } from "../../ports/camera-probe.js";

export type AlignInputStream = NodeJS.ReadableStream & {
  isTTY?: boolean | undefined;
};

export type AlignDiagnosticStream = NodeJS.WritableStream & {
  isTTY?: boolean | undefined;
};

export type AlignPromptContext = NonNullable<
  Parameters<typeof confirm>[1]
>;

export interface AlignPromptFunctions {
  confirm: (
    config: { message: string; default: boolean },
    context: AlignPromptContext
  ) => Promise<unknown>;
}

const defaultPrompts: AlignPromptFunctions = {
  confirm: async (config, context) => confirm(config, context)
};

function formatValues(values: CameraProbeResult): string {
  const lines: string[] = [
    `  Camera package:    ${values.packageName}`,
    `  Camera activity:   ${values.activityName}`,
    ...(values.confirmActivityName === undefined
      ? []
      : [`  Review activity:   ${values.confirmActivityName}`]),
    `  Shutter button:    ${values.shutterResourceId}${
      values.shutterContentDescription !== undefined
        ? `  (${values.shutterContentDescription})`
        : ""
    }`
  ];
  if (values.confirmResourceId !== undefined) {
    lines.push(
      `  Confirm button:    ${values.confirmResourceId}${
        values.confirmContentDescription !== undefined
          ? `  (${values.confirmContentDescription})`
          : ""
      }`
    );
  } else {
    lines.push("  Confirm button:    (none — camera auto-accepts)");
  }
  return lines.join("\n");
}

export class InquirerAlignPrompt implements AlignPromptPort {
  public constructor(
    private readonly prompts: AlignPromptFunctions = defaultPrompts,
    private readonly promptInput: AlignInputStream = process.stdin,
    private readonly diagnostics: AlignDiagnosticStream = process.stderr
  ) {}

  public async confirmWrite(input: {
    values: CameraProbeResult;
    targetPath: string;
  }): Promise<boolean> {
    this.assertLocalTty();
    const body = formatValues(input.values);
    let answer: unknown;
    try {
      answer = await this.prompts.confirm(
        {
          message: `${body}\n\nWrite flow to ${input.targetPath}?`,
          default: true
        },
        { input: this.promptInput, output: this.diagnostics }
      );
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.name === "AbortPromptError"
          || error.name === "ExitPromptError"
        )
      ) {
        throw new AlignPromptCancelledError();
      }
      throw error;
    }
    if (typeof answer !== "boolean") {
      throw new Error("Align confirm prompt returned an invalid answer");
    }
    return answer;
  }

  private assertLocalTty(): void {
    if (
      this.promptInput.isTTY !== true
      || this.diagnostics.isTTY !== true
    ) {
      throw new Error("Align confirm requires local TTY input and diagnostics");
    }
  }
}
