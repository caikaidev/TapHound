import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { parseUiAutomatorLayout } from "./ui-automator-parser.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import type { CommandResult } from "../../ports/process-runner.js";
import type {
  CaptureUiSnapshotOptions,
  OpenUiSnapshotProviderOptions,
  UiSnapshot,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import {
  readDeviceUiEnvironment,
  type DeviceUiEnvironment
} from "../ui/device-ui-environment.js";
import { UiSnapshotError } from "../ui/ui-snapshot-error.js";
import {
  snapshotFromCapture,
  type UiSnapshotTiming
} from "../ui/ui-snapshot-support.js";

interface SystemUiAutomatorFactoryOptions extends UiSnapshotTiming {
  createLayoutPath?: (() => string) | undefined;
}

function descriptor(sdkLevel: number): UiBackendDescriptor {
  return {
    id: "system-uiautomator",
    adapterVersion: "system-uiautomator-v1",
    engineVersion: `android-api-${String(sdkLevel)}`,
    configSha256: createHash("sha256")
      .update(JSON.stringify({ command: "uiautomator dump", version: 1 }))
      .digest("hex")
  };
}

class SystemUiAutomatorSnapshotProvider implements UiSnapshotProvider {
  private closed = false;

  public constructor(
    private readonly runner: ProcessRunner,
    private readonly deviceSerial: string,
    private readonly environment: DeviceUiEnvironment,
    public readonly descriptor: UiBackendDescriptor,
    private readonly createLayoutPath: () => string,
    private readonly timing: UiSnapshotTiming
  ) {}

  public async capture(
    options: CaptureUiSnapshotOptions
  ): Promise<UiSnapshot> {
    if (this.closed) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        "UI snapshot provider is closed"
      );
    }
    const startedAt = performance.now();
    const path = this.createLayoutPath();
    const deadline = startedAt + options.timeoutMs;
    const run = (
      args: readonly string[],
      timeoutMs: number
    ): Promise<CommandResult> => (
      this.runner.run({
        executable: "adb",
        args: ["-s", this.deviceSerial, ...args],
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    );
    try {
      const dumped = await run(
        ["shell", "uiautomator", "dump", path],
        options.timeoutMs
      );
      if (
        dumped.exitCode !== 0
        || dumped.timedOut
        || dumped.cancelled
        || dumped.spawnError !== undefined
      ) {
        throw new UiSnapshotError(
          "UI_SNAPSHOT_FAILED",
          this.descriptor.id,
          dumped.stderr.trim() || dumped.spawnError || "UIAutomator dump failed",
          { terminal: dumped.timedOut || dumped.cancelled }
        );
      }
      const xml = await run(
        ["exec-out", "cat", path],
        Math.max(1, deadline - performance.now())
      );
      if (
        xml.exitCode !== 0
        || xml.timedOut
        || xml.cancelled
        || xml.spawnError !== undefined
      ) {
        throw new UiSnapshotError(
          "UI_SNAPSHOT_FAILED",
          this.descriptor.id,
          xml.stderr.trim() || xml.spawnError || "UIAutomator source read failed",
          { terminal: xml.timedOut || xml.cancelled }
        );
      }
      let roots;
      try {
        roots = parseUiAutomatorLayout(xml.stdout);
      } catch (error) {
        throw new UiSnapshotError(
          "UI_SNAPSHOT_INVALID",
          this.descriptor.id,
          "UIAutomator returned malformed page source",
          { cause: error }
        );
      }
      if (roots.length === 0) {
        throw new UiSnapshotError(
          "UI_SNAPSHOT_INVALID",
          this.descriptor.id,
          "UIAutomator returned an empty layout"
        );
      }
      return snapshotFromCapture({
        startedAt,
        roots,
        backend: this.descriptor,
        viewport: this.environment.viewport,
        timing: this.timing
      });
    } finally {
      await this.runner.run({
        executable: "adb",
        args: ["-s", this.deviceSerial, "shell", "rm", "-f", path],
        timeoutMs: 1000
      }).catch((): undefined => undefined);
    }
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class SystemUiAutomatorSnapshotProviderFactory implements
  UiSnapshotProviderFactory {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly options: SystemUiAutomatorFactoryOptions = {}
  ) {}

  public async open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    const environment = await readDeviceUiEnvironment(
      this.runner,
      "system-uiautomator",
      options
    );
    const provider = new SystemUiAutomatorSnapshotProvider(
      this.runner,
      options.deviceSerial,
      environment,
      descriptor(environment.sdkLevel),
      this.options.createLayoutPath ?? ((): string => (
        `/data/local/tmp/taphound-uiautomator-${randomUUID()}.xml`
      )),
      this.options
    );
    try {
      await provider.capture({
        reason: "evidence",
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
    } catch (error) {
      if (
        error instanceof UiSnapshotError
        && error.code === "UI_SNAPSHOT_FAILED"
        && !error.terminal
        && options.signal?.aborted !== true
      ) {
        throw new UiSnapshotError(
          "UI_BACKEND_UNAVAILABLE",
          "system-uiautomator",
          error.message,
          { cause: error }
        );
      }
      throw error;
    }
    return provider;
  }
}
