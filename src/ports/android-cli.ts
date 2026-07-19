import type { LayoutElement } from "../domain/layout.js";
import type { CommandResult } from "./process-runner.js";

export interface Point {
  x: number;
  y: number;
}

export interface DescribeProjectOptions {
  projectDir: string;
  target: string;
  variant: string;
  signal?: AbortSignal | undefined;
}

export interface ArtifactDescription {
  apkPath: string;
  metadataPaths: readonly string[];
  packageName?: string | undefined;
}

export interface RunAppOptions {
  apkPath: string;
  activity: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

export interface DeviceCommandOptions {
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface CaptureScreenOptions extends DeviceCommandOptions {
  outputPath: string;
  annotate?: boolean | undefined;
}

export interface AndroidCliPort {
  describeProject: (
    options: DescribeProjectOptions
  ) => Promise<ArtifactDescription>;
  runApp: (options: RunAppOptions) => Promise<CommandResult>;
  layout: (
    options: DeviceCommandOptions
  ) => Promise<readonly LayoutElement[]>;
  layoutDiff: (
    options: DeviceCommandOptions
  ) => Promise<readonly unknown[]>;
  captureScreen: (
    options: CaptureScreenOptions
  ) => Promise<CommandResult>;
  resolveScreen: (
    screenshotPath: string,
    label: string,
    signal?: AbortSignal
  ) => Promise<Point>;
}
