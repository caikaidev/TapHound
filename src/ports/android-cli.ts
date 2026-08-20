import type { LayoutElement } from "../domain/layout.js";
import type { CommandResult } from "./process-runner.js";

export interface Point {
  x: number;
  y: number;
}

export interface DeviceCommandOptions {
  deviceSerial: string;
  packageName?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface CaptureScreenOptions extends DeviceCommandOptions {
  outputPath: string;
  annotate?: boolean | undefined;
}

export interface LayoutDiffObservation {
  changes: readonly unknown[];
  layout?: readonly LayoutElement[] | undefined;
  backend?: "uiautomator" | "androidCli" | "gfxFrameStats" | undefined;
  durationMs?: number | undefined;
}

export type LayoutDiffResult =
  | readonly unknown[]
  | LayoutDiffObservation;

export interface AndroidCliPort {
  layout: (
    options: DeviceCommandOptions
  ) => Promise<readonly LayoutElement[]>;
  layoutDiff: (
    options: DeviceCommandOptions
  ) => Promise<LayoutDiffResult>;
  captureScreen: (
    options: CaptureScreenOptions
  ) => Promise<CommandResult>;
  resolveScreen: (
    screenshotPath: string,
    label: string,
    signal?: AbortSignal
  ) => Promise<Point>;
}
