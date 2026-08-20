import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  AndroidCliPort,
  CaptureScreenOptions,
  DeviceCommandOptions,
  LayoutDiffObservation,
  Point
} from "../../ports/android-cli.js";
import type {
  CommandResult,
  ProcessRunner
} from "../../ports/process-runner.js";
import {
  parseLayout,
  parseLayoutDiff
} from "./layout-parser.js";
import { parseUiAutomatorLayout } from "../adb/ui-automator-parser.js";

function commandSpec(
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number
): {
  executable: string;
  args: readonly string[];
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
} {
  return {
    executable: "android",
    args,
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function adbCommandSpec(
  deviceSerial: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs?: number
): {
  executable: string;
  args: readonly string[];
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
} {
  return {
    executable: "adb",
    args: ["-s", deviceSerial, ...args],
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function assertSuccess(result: CommandResult, operation: string): void {
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.spawnError !== undefined
  ) {
    throw new Error(
      `Android CLI ${operation} failed: ${
        result.stderr.trim() || result.spawnError || "command failed"
      }`
    );
  }
}

class UiAutomatorUnavailableError extends Error {
  public override readonly name = "UiAutomatorUnavailableError";
}

function assertUiAutomatorSuccess(
  result: CommandResult,
  operation: string
): void {
  if (result.timedOut || result.cancelled) {
    throw Object.assign(
      new Error(`UIAutomator ${operation} did not complete before its deadline`),
      { terminal: true }
    );
  }
  if (result.exitCode !== 0 || result.spawnError !== undefined) {
    throw new UiAutomatorUnavailableError(
      result.stderr.trim()
        || result.spawnError
        || `UIAutomator ${operation} failed`
    );
  }
}

function terminalBackendFailure(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "terminal" in error
    && error.terminal === true;
}

export class AndroidCliAdapter implements AndroidCliPort {
  private readonly frameSignatures = new Map<string, string>();

  public constructor(
    private readonly runner: ProcessRunner,
    private readonly createLayoutPath: () => string = () => (
      `/data/local/tmp/taphound-uiautomator-${randomUUID()}.xml`
    )
  ) {}

  private async readUiAutomator(
    options: DeviceCommandOptions
  ): Promise<{
    layout: ReturnType<typeof parseUiAutomatorLayout>;
  }> {
    const path = this.createLayoutPath();
    const deadline = options.timeoutMs === undefined
      ? undefined
      : performance.now() + options.timeoutMs;
    const dumped = await this.runner.run(adbCommandSpec(
      options.deviceSerial,
      ["shell", "uiautomator", "dump", path],
      options.signal,
      options.timeoutMs
    ));
    try {
      assertUiAutomatorSuccess(dumped, "dump");
      const remainingMs = deadline === undefined
        ? undefined
        : Math.max(1, deadline - performance.now());
      const xml = await this.runner.run(adbCommandSpec(
        options.deviceSerial,
        ["exec-out", "cat", path],
        options.signal,
        remainingMs
      ));
      assertUiAutomatorSuccess(xml, "read");
      const layout = parseUiAutomatorLayout(xml.stdout);
      if (layout.length === 0) {
        throw new Error("UIAutomator dump contained no layout roots");
      }
      return { layout };
    } finally {
      await this.runner.run(adbCommandSpec(
        options.deviceSerial,
        ["shell", "rm", "-f", path],
        undefined,
        1000
      ));
    }
  }

  public async layout(
    options: DeviceCommandOptions
  ): Promise<ReturnType<typeof parseLayout>> {
    const startedAt = performance.now();
    try {
      const current = await this.readUiAutomator(options);
      return current.layout;
    } catch (error) {
      if (terminalBackendFailure(error)) throw error;
      // Fall back to the Android CLI layout representation below.
    }
    const result = await this.runner.run(commandSpec([
      "layout",
      `--device=${options.deviceSerial}`
    ], options.signal, options.timeoutMs === undefined
      ? undefined
      : Math.max(1, options.timeoutMs - (performance.now() - startedAt))));
    assertSuccess(result, "layout");
    return parseLayout(result.stdout);
  }

  public async layoutDiff(
    options: DeviceCommandOptions
  ): Promise<LayoutDiffObservation> {
    const startedAt = performance.now();
    if (options.packageName !== undefined) {
      const result = await this.runner.run(adbCommandSpec(
        options.deviceSerial,
        ["shell", "dumpsys", "gfxinfo", options.packageName],
        options.signal,
        options.timeoutMs
      ));
      assertSuccess(result, "frame stability");
      const signature = result.stdout.match(
        /^Total frames rendered:\s*(\d+)\s*$/m
      )?.[1];
      if (signature !== undefined) {
        const key = `${options.deviceSerial}\u0000${options.packageName}`;
        const previous = this.frameSignatures.get(key);
        this.frameSignatures.set(key, signature);
        return {
          changes: previous === signature ? [] : [{ frameStats: signature }],
          backend: "gfxFrameStats",
          durationMs: performance.now() - startedAt
        };
      }
    }
    const result = await this.runner.run(commandSpec([
      "layout",
      "--diff",
      `--device=${options.deviceSerial}`
    ], options.signal, options.timeoutMs));
    assertSuccess(result, "layout --diff");
    return {
      changes: parseLayoutDiff(result.stdout),
      backend: "androidCli",
      durationMs: performance.now() - startedAt
    };
  }

  public captureScreen(options: CaptureScreenOptions): Promise<CommandResult> {
    return this.runner.run(commandSpec([
      "screen",
      "capture",
      `--output=${options.outputPath}`,
      ...(options.annotate === true ? ["--annotate"] : []),
      `--device=${options.deviceSerial}`
    ], options.signal, options.timeoutMs));
  }

  public async resolveScreen(
    screenshotPath: string,
    label: string,
    signal?: AbortSignal
  ): Promise<Point> {
    const result = await this.runner.run(commandSpec([
      "screen",
      "resolve",
      `--screenshot=${screenshotPath}`,
      `--string=${label}`
    ], signal));
    assertSuccess(result, "screen resolve");
    const coordinates = result.stdout.match(/-?\d+/g)?.map(Number);
    if (coordinates?.length !== 2) {
      throw new Error("Android CLI screen resolve returned invalid coordinates");
    }
    const [x, y] = coordinates;
    if (x === undefined || y === undefined || x < 0 || y < 0) {
      throw new Error("Android CLI screen resolve returned invalid coordinates");
    }
    return { x, y };
  }
}
