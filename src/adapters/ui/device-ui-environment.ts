import { performance } from "node:perf_hooks";

import {
  DisplayViewportSchema,
  type DisplayViewport
} from "../../domain/geometry.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type {
  CommandResult,
  ProcessRunner
} from "../../ports/process-runner.js";
import { UiSnapshotError } from "./ui-snapshot-error.js";

export interface DeviceUiEnvironment {
  sdkLevel: number;
  viewport: DisplayViewport;
}

function usable(result: CommandResult): boolean {
  return result.exitCode === 0
    && !result.timedOut
    && !result.cancelled
    && result.spawnError === undefined;
}

function message(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.spawnError || fallback;
}

export function parseDisplayRotation(
  dumpsysInput: string
): DisplayViewport["rotation"] | undefined {
  const orientation = /SurfaceOrientation:\s*([0-3])/i.exec(dumpsysInput)?.[1]
    ?? /Viewport[^\n]*\borientation=([0-3])\b/i.exec(dumpsysInput)?.[1];
  if (orientation !== undefined) {
    return ([0, 90, 180, 270] as const)[Number(orientation)];
  }
  const degrees = /\bROT_(0|90|180|270)\b/i.exec(dumpsysInput)?.[1];
  if (degrees === undefined) return undefined;
  const parsed = Number(degrees);
  return parsed === 0 || parsed === 90 || parsed === 180 || parsed === 270
    ? parsed
    : undefined;
}

export async function readDeviceUiEnvironment(
  runner: ProcessRunner,
  backendId: UiBackendDescriptor["id"],
  options: {
    deviceSerial: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }
): Promise<DeviceUiEnvironment> {
  const startedAt = performance.now();
  const run = async (args: readonly string[]): Promise<CommandResult> => {
    const remainingMs = Math.max(
      1,
      options.timeoutMs - (performance.now() - startedAt)
    );
    const result = await runner.run({
      executable: "adb",
      args: ["-s", options.deviceSerial, ...args],
      timeoutMs: remainingMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (!usable(result)) {
      throw new UiSnapshotError(
        result.timedOut || result.cancelled
          ? "UI_SNAPSHOT_FAILED"
          : "UI_BACKEND_UNAVAILABLE",
        backendId,
        message(result, `Unable to inspect device UI environment`)
      );
    }
    return result;
  };

  const sdkResult = await run([
    "shell",
    "getprop",
    "ro.build.version.sdk"
  ]);
  const sdkLevel = Number(sdkResult.stdout.trim());
  if (!Number.isSafeInteger(sdkLevel)) {
    throw new UiSnapshotError(
      "UI_BACKEND_UNAVAILABLE",
      backendId,
      "Device returned an invalid Android SDK level"
    );
  }
  if (sdkLevel < 26) {
    throw new UiSnapshotError(
      "UI_BACKEND_UNAVAILABLE",
      backendId,
      `UI snapshots require Android API 26 or newer; device is API ${String(sdkLevel)}`
    );
  }

  const sizeResult = await run(["shell", "wm", "size"]);
  const size = /(?:Physical size:\s*)?(\d+)x(\d+)/i.exec(
    sizeResult.stdout
  );
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new UiSnapshotError(
      "UI_BACKEND_UNAVAILABLE",
      backendId,
      "Device returned an invalid physical display size"
    );
  }

  const rotationResult = await run(["shell", "dumpsys", "input"]);
  const rotation = parseDisplayRotation(rotationResult.stdout);
  if (rotation === undefined) {
    throw new UiSnapshotError(
      "UI_BACKEND_UNAVAILABLE",
      backendId,
      "Device returned an invalid display rotation"
    );
  }

  return {
    sdkLevel,
    viewport: DisplayViewportSchema.parse({
      width,
      height,
      rotation,
      coordinateSpace: "physicalDisplayPixels"
    })
  };
}
