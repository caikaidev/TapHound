import { describe, expect, it, vi } from "vitest";

import { ObserveService } from "../../src/application/observe/observe-service.js";
import type { ForegroundComponent } from "../../src/domain/activity.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import type { AdbPort } from "../../src/ports/adb.js";
import type { CommandResult } from "../../src/ports/process-runner.js";
import type {
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../src/ports/ui-snapshot.js";
import { commandResult } from "../fakes/process-runner.js";
import {
  uiSnapshotFactory,
  uiSnapshotProvider
} from "../fakes/ui-snapshot.js";

const TARGET_PACKAGE = "com.example.app";
const DEVICE_SERIAL = "emulator-5554";
const TARGET_ACTIVITY = "com.example.app.MainActivity";

function layoutElement(): LayoutElement {
  return {
    id: "root",
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 200 },
    children: []
  };
}

interface FakeOverrides {
  foreground?: ForegroundComponent;
  currentActivity?: () => Promise<string>;
  layout?: () => Promise<readonly LayoutElement[]>;
  dumpLogcat?: () => Promise<CommandResult>;
  close?: () => Promise<void>;
}

function makeFakes(overrides: FakeOverrides = {}): {
  adb: AdbPort;
  uiSnapshots: UiSnapshotProviderFactory;
  provider: UiSnapshotProvider;
} {
  const foreground = overrides.foreground ?? {
    packageName: TARGET_PACKAGE,
    activity: TARGET_ACTIVITY
  };
  const adb: AdbPort = {
    devices: vi.fn(),
    foregroundComponent: vi.fn(() => Promise.resolve(foreground)),
    currentActivity: vi.fn(
      overrides.currentActivity
        ?? ((): Promise<string> => Promise.resolve(TARGET_ACTIVITY))
    ),
    isInstalled: vi.fn(),
    launchActivity: vi.fn(),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(),
    forceStop: vi.fn(),
    appProcesses: vi.fn(),
    windowTopology: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(),
    dumpLogcat: vi.fn(
      overrides.dumpLogcat
        ?? ((): Promise<CommandResult> => Promise.resolve(commandResult({
          stdout: "line-1\nline-2\nline-3\n"
        })))
    )
  };
  const provider = uiSnapshotProvider([layoutElement()]);
  if (overrides.close !== undefined) {
    vi.mocked(provider.close).mockImplementation(overrides.close);
  }
  if (overrides.layout !== undefined) {
    vi.mocked(provider.capture).mockImplementation(async () => ({
      observationId: "test-observation",
      capturedAt: "2026-08-30T08:00:00.000Z",
      durationMs: 1,
      backend: provider.descriptor,
      viewport: {
        width: 1080,
        height: 1920,
        rotation: 0,
        coordinateSpace: "physicalDisplayPixels"
      },
      roots: await overrides.layout?.() ?? []
    }));
  }
  return { adb, provider, uiSnapshots: uiSnapshotFactory(provider) };
}

function makeService(fakes: {
  adb: AdbPort;
  uiSnapshots: UiSnapshotProviderFactory;
}): ObserveService {
  return new ObserveService({
    adb: fakes.adb,
    uiSnapshots: fakes.uiSnapshots,
    layoutTimeoutMs: 5000
  });
}

describe("ObserveService", () => {
  it("returns activity and foreground when target package is in foreground", async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(report).toMatchObject({
      deviceSerial: DEVICE_SERIAL,
      packageName: TARGET_PACKAGE,
      activity: TARGET_ACTIVITY,
      foreground: {
        packageName: TARGET_PACKAGE,
        activity: TARGET_ACTIVITY
      }
    });
    expect(report.layout).toHaveLength(1);
    expect(report.logcat).toBeUndefined();
    expect(fakes.adb.dumpLogcat).not.toHaveBeenCalled();
    expect(fakes.uiSnapshots.open).toHaveBeenCalledWith({
      deviceSerial: DEVICE_SERIAL,
      timeoutMs: 5000
    });
    expect(fakes.provider.capture).toHaveBeenCalledWith({
      reason: "observe",
      timeoutMs: 5000
    });
    expect(fakes.provider.close).toHaveBeenCalledOnce();
  });

  it("exposes session cache telemetry without making it authoritative evidence", async () => {
    const fakes = makeFakes();
    fakes.provider.cacheTelemetry = (): {
      hits: number;
      misses: number;
      stale: number;
      relearns: number;
      capturesSaved: number;
      validationDurationMs: number;
    } => ({
      hits: 1,
      misses: 2,
      stale: 0,
      relearns: 0,
      capturesSaved: 1,
      validationDurationMs: 3
    });
    const report = await makeService(fakes).observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(report.uiCache).toMatchObject({ hits: 1, capturesSaved: 1 });
  });

  it("omits activity when a different package is in the foreground", async () => {
    const otherForeground: ForegroundComponent = {
      packageName: "com.other.app",
      activity: "com.other.app.OtherActivity"
    };
    const fakes = makeFakes({
      foreground: otherForeground,
      currentActivity: () => Promise.resolve("com.other.app.OtherActivity")
    });
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(report.activity).toBeUndefined();
    expect(report.foreground).toEqual(otherForeground);
    expect(fakes.adb.currentActivity).not.toHaveBeenCalled();
  });

  it("reports foreground activity when target package is in the foreground", async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(report.activity).toBe(TARGET_ACTIVITY);
    expect(fakes.adb.currentActivity).not.toHaveBeenCalled();
  });

  it("rethrows layout errors", async () => {
    const fakes = makeFakes({
      layout: () => Promise.reject(new Error("layout dump failed")),
      close: () => Promise.reject(new Error("provider close failed"))
    });
    const service = makeService(fakes);

    await expect(service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    })).rejects.toThrow("layout dump failed");
  });

  it("includes logcat lines when logcatLines is set", async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 50
    });

    expect(report.logcat).toEqual(["line-1", "line-2", "line-3"]);
    expect(fakes.adb.dumpLogcat).toHaveBeenCalledWith(expect.objectContaining({
      deviceSerial: DEVICE_SERIAL,
      maxLines: 50
    }));
  });

  it("omits logcat when logcatLines is missing or zero", async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);

    const noLinesReport = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });
    expect(noLinesReport.logcat).toBeUndefined();

    const zeroLinesReport = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 0
    });
    expect(zeroLinesReport.logcat).toBeUndefined();
    expect(fakes.adb.dumpLogcat).not.toHaveBeenCalled();
  });

  it("throws when dumpLogcat returns a failed command result", async () => {
    const fakes = makeFakes({
      dumpLogcat: () => Promise.resolve(commandResult({
        exitCode: 1,
        stderr: "logcat unavailable"
      }))
    });
    const service = makeService(fakes);

    await expect(service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 50
    })).rejects.toThrow("logcat unavailable");
  });
});
