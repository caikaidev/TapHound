import type {
  AndroidCliPort,
  CaptureScreenOptions,
  DeviceCommandOptions,
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

function assertSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `Android CLI ${operation} failed: ${result.stderr.trim()}`
    );
  }
}

export class AndroidCliAdapter implements AndroidCliPort {
  public constructor(private readonly runner: ProcessRunner) {}

  public async layout(
    options: DeviceCommandOptions
  ): Promise<ReturnType<typeof parseLayout>> {
    const result = await this.runner.run(commandSpec([
      "layout",
      `--device=${options.deviceSerial}`
    ], options.signal, options.timeoutMs));
    assertSuccess(result, "layout");
    return parseLayout(result.stdout);
  }

  public async layoutDiff(
    options: DeviceCommandOptions
  ): Promise<ReturnType<typeof parseLayoutDiff>> {
    const result = await this.runner.run(commandSpec([
      "layout",
      "--diff",
      `--device=${options.deviceSerial}`
    ], options.signal, options.timeoutMs));
    assertSuccess(result, "layout --diff");
    return parseLayoutDiff(result.stdout);
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
