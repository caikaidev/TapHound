import type { CommandResult } from "./process-runner.js";

export interface ScreenshotOptions {
  deviceSerial: string;
  outputPath: string;
  annotate?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ScreenshotPort {
  capture: (options: ScreenshotOptions) => Promise<CommandResult>;
}
