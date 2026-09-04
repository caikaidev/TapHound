import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { parseLayout } from "./layout-parser.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
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

function descriptor(sdkLevel: number): UiBackendDescriptor {
  return {
    id: "android-cli",
    adapterVersion: "android-cli-layout-v1",
    engineVersion: `android-api-${String(sdkLevel)}`,
    configSha256: createHash("sha256")
      .update(JSON.stringify({ command: "android layout", version: 1 }))
      .digest("hex")
  };
}

class AndroidCliSnapshotProvider implements UiSnapshotProvider {
  private closed = false;

  public constructor(
    private readonly runner: ProcessRunner,
    private readonly deviceSerial: string,
    private readonly environment: DeviceUiEnvironment,
    public readonly descriptor: UiBackendDescriptor,
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
    const result = await this.runner.run({
      executable: "android",
      args: ["layout", `--device=${this.deviceSerial}`],
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (
      result.exitCode !== 0
      || result.timedOut
      || result.cancelled
      || result.spawnError !== undefined
    ) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        result.stderr.trim() || result.spawnError || "Android CLI layout failed",
        { terminal: result.timedOut || result.cancelled }
      );
    }
    let roots;
    try {
      roots = parseLayout(result.stdout);
    } catch (error) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "Android CLI returned malformed layout source",
        { cause: error }
      );
    }
    if (roots.length === 0) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "Android CLI returned an empty layout"
      );
    }
    return snapshotFromCapture({
      startedAt,
      roots,
      backend: this.descriptor,
      viewport: this.environment.viewport,
      timing: this.timing
    });
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class AndroidCliSnapshotProviderFactory implements
  UiSnapshotProviderFactory {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly timing: UiSnapshotTiming = {}
  ) {}

  public async open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    const environment = await readDeviceUiEnvironment(
      this.runner,
      "android-cli",
      options
    );
    const provider = new AndroidCliSnapshotProvider(
      this.runner,
      options.deviceSerial,
      environment,
      descriptor(environment.sdkLevel),
      this.timing
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
          "android-cli",
          error.message,
          { cause: error }
        );
      }
      throw error;
    }
    return provider;
  }
}
