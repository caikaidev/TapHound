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
}

export interface RunAppOptions {
  apkPath: string;
  activity: string;
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

export interface AndroidCliPort {
  describeProject: (
    options: DescribeProjectOptions
  ) => Promise<ArtifactDescription>;
  runApp: (options: RunAppOptions) => Promise<CommandResult>;
  layout: (signal?: AbortSignal) => Promise<readonly LayoutElement[]>;
  layoutDiff: (signal?: AbortSignal) => Promise<readonly unknown[]>;
  captureScreen: (
    outputPath: string,
    annotate?: boolean,
    signal?: AbortSignal
  ) => Promise<CommandResult>;
  resolveScreen: (
    screenshotPath: string,
    label: string,
    signal?: AbortSignal
  ) => Promise<Point>;
}
