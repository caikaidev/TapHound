import { describe, expect, it, vi } from "vitest";

import { ObserveService } from "../../src/application/observe/observe-service.js";
import {
  FakeRuntimeBackend,
  FakeRuntimeSession,
  fakeRuntimeCapabilities
} from "../../src/adapters/runtime/fake-runtime-backend.js";
import type { ForegroundComponent } from "../../src/domain/activity.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import type { RuntimeCapabilities } from "../../src/domain/runtime.js";
import type { CommandResult } from "../../src/ports/process-runner.js";
import type { UiSnapshotProvider } from "../../src/ports/ui-snapshot.js";
import { commandResult } from "../fakes/process-runner.js";
import { uiSnapshotProvider } from "../fakes/ui-snapshot.js";

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
  capabilities?: Partial<RuntimeCapabilities>;
  foreground?: ForegroundComponent;
  dumpLogcatResult?: CommandResult;
  provider?: UiSnapshotProvider;
}

function makeFakes(overrides: FakeOverrides = {}): {
  backend: FakeRuntimeBackend;
  provider: UiSnapshotProvider;
} {
  const capabilities: RuntimeCapabilities = {
    ...fakeRuntimeCapabilities(),
    foregroundActivity: true,
    ...(overrides.capabilities ?? {})
  };
  const provider = overrides.provider ?? uiSnapshotProvider([layoutElement()]);
  const backend = new FakeRuntimeBackend({ capabilities });
  backend.createSession = (options): FakeRuntimeSession => {
    const session = new FakeRuntimeSession({
      descriptor: backend.descriptor,
      deviceSerial: options.deviceSerial,
      uiSnapshots: provider
    });
    session.state = {
      foreground: overrides.foreground ?? {
        packageName: TARGET_PACKAGE,
        activity: TARGET_ACTIVITY
      },
      ...(overrides.dumpLogcatResult === undefined
        ? {}
        : { dumpLogcatResult: overrides.dumpLogcatResult })
    };
    backend.sessions.push(session);
    return session;
  };
  return { backend, provider };
}

function makeService(fakes: {
  backend: FakeRuntimeBackend;
}): ObserveService {
  return new ObserveService({
    sessions: fakes.backend,
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
    expect(fakes.backend.openCalls).toEqual([{ deviceSerial: DEVICE_SERIAL }]);
    const session = fakes.backend.sessions[0];
    expect(session?.calls).toContain(`foregroundComponent:${TARGET_PACKAGE}`);
    expect(session?.calls).toContain("openUiSnapshots");
    expect(session?.calls).not.toContain(`currentActivity:${TARGET_PACKAGE}`);
    expect(session?.lastUiSnapshotOptions).toMatchObject({ timeoutMs: 5000 });
    expect(fakes.provider.capture).toHaveBeenCalledWith({
      reason: "observe",
      timeoutMs: 5000
    });
    expect(fakes.provider.close).toHaveBeenCalledOnce();
  });

  it("borrows one session per observe run", async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);

    await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });
    await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(fakes.backend.openCalls).toHaveLength(2);
    expect(fakes.backend.sessions).toHaveLength(2);
  });

  it("passes the ui backend and cache selection to the session snapshots", async () => {
    const fakes = makeFakes();
    const service = new ObserveService({
      sessions: fakes.backend,
      layoutTimeoutMs: 5000,
      backend: "system-uiautomator",
      cacheEnabled: false
    });

    await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(fakes.backend.sessions[0]?.lastUiSnapshotOptions).toEqual({
      timeoutMs: 5000,
      backend: "system-uiautomator",
      cacheEnabled: false
    });
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
    const fakes = makeFakes({ foreground: otherForeground });
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    });

    expect(report.activity).toBeUndefined();
    expect(report.foreground).toEqual(otherForeground);
    expect(fakes.backend.sessions[0]?.calls)
      .not.toContain(`currentActivity:${TARGET_PACKAGE}`);
  });

  it("rethrows layout errors", async () => {
    const provider = uiSnapshotProvider([layoutElement()]);
    vi.mocked(provider.capture).mockImplementation(
      () => Promise.reject(new Error("layout dump failed"))
    );
    vi.mocked(provider.close).mockImplementation(
      () => Promise.reject(new Error("provider close failed"))
    );
    const fakes = makeFakes({ provider });
    const service = makeService(fakes);

    await expect(service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    })).rejects.toThrow("layout dump failed");
  });

  it("includes logcat lines when logcatLines is set", async () => {
    const fakes = makeFakes({
      dumpLogcatResult: commandResult({
        stdout: "line-1\nline-2\nline-3\n"
      })
    });
    const service = makeService(fakes);

    const report = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 50
    });

    expect(report.logcat).toEqual(["line-1", "line-2", "line-3"]);
    expect(fakes.backend.sessions[0]?.calls).toContain("dumpLogcat:50");
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
    expect(fakes.backend.sessions[0]?.calls).not.toContain("dumpLogcat:0");
  });

  it("throws when dumpLogcat returns a failed command result", async () => {
    const fakes = makeFakes({
      dumpLogcatResult: commandResult({
        exitCode: 1,
        stderr: "logcat unavailable"
      })
    });
    const service = makeService(fakes);

    await expect(service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 50
    })).rejects.toThrow("logcat unavailable");
  });

  it("fails closed when the session cannot read the foreground component", async () => {
    const fakes = makeFakes({
      capabilities: { foregroundActivity: false }
    });
    const service = makeService(fakes);

    const rejection = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL
    }).then(
      () => undefined,
      (error: unknown): unknown => error
    ) as { code?: unknown; message?: unknown };
    expect(rejection.code).toBe("RUNTIME_CAPABILITY_MISSING");
    expect(rejection.message).toContain("foregroundComponent");
    expect(rejection.message).toContain("TAPHOUND_RUNTIME_BACKEND");
    expect(fakes.backend.sessions[0]?.calls).not.toContain("openUiSnapshots");
    expect(fakes.provider.capture).not.toHaveBeenCalled();
  });

  it("fails closed when logcat is requested without the dump capability", async () => {
    const fakes = makeFakes({
      capabilities: { logs: false }
    });
    const service = makeService(fakes);

    const rejection = await service.observe({
      packageName: TARGET_PACKAGE,
      deviceSerial: DEVICE_SERIAL,
      logcatLines: 50
    }).then(
      () => undefined,
      (error: unknown): unknown => error
    ) as { code?: unknown; message?: unknown };
    expect(rejection.code).toBe("RUNTIME_CAPABILITY_MISSING");
    expect(rejection.message).toContain("dumpLogcat");
    expect(rejection.message).toContain("TAPHOUND_RUNTIME_BACKEND");
  });
});
