import { describe, expect, it, vi } from "vitest";

import {
  AdbRuntimeBackend,
  ADB_RUNTIME_ADAPTER_VERSION,
  DEFAULT_RUNTIME_UI_SNAPSHOT_TIMEOUT_MS
} from "../../../src/adapters/runtime/adb-runtime-backend.js";
import { AdbAdapter } from "../../../src/adapters/adb/adb-adapter.js";
import type { AdbPort, AppIdentity } from "../../../src/ports/adb.js";
import type { ScreenshotPort } from "../../../src/ports/screenshot.js";
import type { UiSnapshotProviderFactory } from "../../../src/ports/ui-snapshot.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";
import {
  uiSnapshotFactory,
  uiSnapshotProvider
} from "../../fakes/ui-snapshot.js";
import {
  describeRuntimeBackendContract,
  type RuntimeBackendContractFixture
} from "./runtime-backend.contract.js";

function fakeAdbPort(): AdbPort {
  return {
    devices: vi.fn(() => Promise.resolve([
      { serial: "emulator-5554", status: "device" }
    ])),
    foregroundComponent: vi.fn((identity: AppIdentity) => Promise.resolve({
      packageName: identity.packageName,
      activity: `${identity.packageName}.MainActivity`
    })),
    currentActivity: vi.fn((identity: AppIdentity) => Promise.resolve(
      `${identity.packageName}.MainActivity`
    )),
    isInstalled: vi.fn(() => Promise.resolve(true)),
    launchActivity: vi.fn(() => Promise.resolve(commandResult())),
    startActivityByIntent: vi.fn(() => Promise.resolve(commandResult())),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(() => Promise.resolve(commandResult())),
    appProcesses: vi.fn((identity: AppIdentity) => Promise.resolve([
      { pid: 42, name: identity.packageName }
    ])),
    windowTopology: vi.fn(() => Promise.resolve({
      version: 1 as const,
      status: "unavailable" as const,
      windows: [],
      diagnostic: "topology not required"
    })),
    tap: vi.fn(() => Promise.resolve(commandResult())),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn(() => ({
      started: Promise.resolve(undefined),
      completion: Promise.resolve(commandResult()),
      stop: vi.fn(() => Promise.resolve(commandResult()))
    })),
    dumpLogcat: vi.fn(() => Promise.resolve(commandResult()))
  };
}

function fakeScreenshots(): ScreenshotPort {
  return {
    capture: vi.fn(() => Promise.resolve(commandResult()))
  };
}

function adbRuntimeFixture(): {
  backend: AdbRuntimeBackend;
  adb: AdbPort;
  screenshots: ScreenshotPort;
  factory: UiSnapshotProviderFactory;
} {
  const adb = fakeAdbPort();
  const screenshots = fakeScreenshots();
  const factory = uiSnapshotFactory(uiSnapshotProvider());
  const annotatedScreens = {
    resolve: vi.fn(() => Promise.resolve({ x: 1, y: 2 }))
  };
  const uiStability = {
    reset: vi.fn(),
    sample: vi.fn(() => Promise.resolve([]))
  };
  const backend = new AdbRuntimeBackend({
    adb,
    screenshots,
    annotatedScreens,
    uiStability,
    uiSnapshots: factory
  });
  return { backend, adb, screenshots, factory };
}

describeRuntimeBackendContract("AdbRuntimeBackend", (): RuntimeBackendContractFixture => {
  const { backend } = adbRuntimeFixture();
  return {
    backend,
    deviceSerial: "emulator-5554",
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity"
  };
});

describe("AdbRuntimeBackend", () => {
  it("declares adb identity and full capabilities", () => {
    const { backend } = adbRuntimeFixture();
    expect(backend.descriptor.id).toBe("adb");
    expect(backend.descriptor.adapterVersion)
      .toBe(ADB_RUNTIME_ADAPTER_VERSION);
    expect(backend.capabilities).toEqual({
      layoutSnapshot: true,
      screenshot: true,
      annotatedScreens: true,
      frameStatsIdle: true,
      logs: true,
      processDiscovery: true,
      windowTopology: true,
      intentStart: true,
      foregroundActivity: true
    });
  });

  it("keeps the descriptor stable across sessions", async () => {
    const { backend } = adbRuntimeFixture();
    const first = await backend.openSession({ deviceSerial: "serial-1" });
    const second = await backend.openSession({ deviceSerial: "serial-2" });
    expect(first.descriptor).toBe(backend.descriptor);
    expect(second.descriptor).toBe(backend.descriptor);
  });

  it("opens sessions without touching the snapshot factory", async () => {
    const { backend, factory } = adbRuntimeFixture();
    await backend.openSession({ deviceSerial: "emulator-5554" });
    expect(vi.mocked(factory.open)).not.toHaveBeenCalled();
  });

  it("passes ui snapshot options to the factory on first open", async () => {
    const { backend, factory } = adbRuntimeFixture();
    const signal = new AbortController().signal;
    const session = await backend.openSession({ deviceSerial: "emulator-5554" });
    await session.openUiSnapshots({
      backend: "android-cli",
      timeoutMs: 2500,
      cacheEnabled: false,
      signal
    });
    expect(vi.mocked(factory.open)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(factory.open)).toHaveBeenCalledWith({
      deviceSerial: "emulator-5554",
      timeoutMs: 2500,
      backend: "android-cli",
      cacheEnabled: false,
      signal
    });
  });

  it("falls back to the default snapshot timeout without options", async () => {
    const { backend, factory } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "emulator-5554" });
    await session.openUiSnapshots();
    expect(vi.mocked(factory.open)).toHaveBeenCalledWith({
      deviceSerial: "emulator-5554",
      timeoutMs: DEFAULT_RUNTIME_UI_SNAPSHOT_TIMEOUT_MS
    });
  });

  it("memoizes the snapshot provider across repeated opens", async () => {
    const { backend, factory } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "emulator-5554" });
    const first = await session.openUiSnapshots({ timeoutMs: 1000 });
    const second = await session.openUiSnapshots({ timeoutMs: 2000 });
    expect(second).toBe(first);
    expect(vi.mocked(factory.open)).toHaveBeenCalledTimes(1);
  });

  it("binds the device serial into delegated app queries", async () => {
    const { backend, adb } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    await session.isInstalled({ packageName: "com.example.app" });
    expect(vi.mocked(adb.isInstalled)).toHaveBeenCalledWith({
      packageName: "com.example.app",
      deviceSerial: "serial-9"
    });
    await session.forceStop({ packageName: "com.example.app", timeoutMs: 50 });
    expect(vi.mocked(adb.forceStop)).toHaveBeenCalledWith({
      packageName: "com.example.app",
      deviceSerial: "serial-9",
      timeoutMs: 50
    });
    await session.launchApp({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      timeoutMs: 60
    });
    expect(vi.mocked(adb.launchActivity)).toHaveBeenCalledWith({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      deviceSerial: "serial-9",
      timeoutMs: 60
    });
  });

  it("delegates actions without the serial parameter", async () => {
    const { backend, adb } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    const point = { x: 12, y: 34 };
    await session.tap(point);
    expect(vi.mocked(adb.tap)).toHaveBeenCalledWith(point, "serial-9", undefined);
    await session.longClick(point, 900);
    expect(vi.mocked(adb.longClick)).toHaveBeenCalledWith(
      point,
      900,
      "serial-9",
      undefined
    );
    await session.swipe(point, { x: 12, y: 60 }, 400);
    expect(vi.mocked(adb.swipe)).toHaveBeenCalledWith(
      point,
      { x: 12, y: 60 },
      400,
      "serial-9",
      undefined
    );
    await session.back();
    expect(vi.mocked(adb.back)).toHaveBeenCalledWith("serial-9", undefined);
    await session.inputText("hi");
    expect(vi.mocked(adb.inputText)).toHaveBeenCalledWith(
      "hi",
      "serial-9",
      undefined
    );
  });

  it("delegates evidence capture with the serial bound", async () => {
    const { backend, adb, screenshots } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    await session.captureScreenshot({
      outputPath: "out.png",
      annotate: true
    });
    expect(vi.mocked(screenshots.capture)).toHaveBeenCalledWith({
      outputPath: "out.png",
      annotate: true,
      deviceSerial: "serial-9"
    });
    await session.dumpLogcat?.({ maxLines: 20 });
    expect(vi.mocked(adb.dumpLogcat)).toHaveBeenCalledWith({
      deviceSerial: "serial-9",
      maxLines: 20
    });
    const onStdoutLine = (): void => undefined;
    session.startLogcat?.({ onStdoutLine });
    expect(vi.mocked(adb.startLogcat)).toHaveBeenCalledWith({
      deviceSerial: "serial-9",
      onStdoutLine
    });
  });

  it("exposes the intent start capability through the session", async () => {
    const { backend, adb } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    expect(session.startActivityByIntent).toBeDefined();
    await session.startActivityByIntent?.({ action: "android.media.action.IMAGE_CAPTURE" });
    expect(vi.mocked(adb.startActivityByIntent)).toHaveBeenCalledWith({
      action: "android.media.action.IMAGE_CAPTURE",
      deviceSerial: "serial-9"
    });
  });

  it("exposes annotated screens and ui stability probes", async () => {
    const { backend } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    expect(session.annotatedScreens).toBeDefined();
    expect(session.uiStability).toBeDefined();
  });

  it("closes the opened snapshot provider on session close", async () => {
    const provider = uiSnapshotProvider();
    const backend = new AdbRuntimeBackend({
      adb: fakeAdbPort(),
      screenshots: fakeScreenshots(),
      annotatedScreens: {
        resolve: vi.fn(() => Promise.resolve({ x: 1, y: 2 }))
      },
      uiStability: {
        reset: vi.fn(),
        sample: vi.fn(() => Promise.resolve([]))
      },
      uiSnapshots: uiSnapshotFactory(provider)
    });
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    await session.openUiSnapshots();
    await session.close();
    expect(vi.mocked(provider.close)).toHaveBeenCalledTimes(1);
  });

  it("closes cleanly without an opened snapshot provider", async () => {
    const { backend, factory } = adbRuntimeFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    await expect(session.close()).resolves.toBeUndefined();
    expect(vi.mocked(factory.open)).not.toHaveBeenCalled();
  });

  it("composes the real AdbAdapter through the shared contract surface", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "List of devices attached",
        "emulator-5554\tdevice",
        ""
      ].join("\n")
    }));
    const backend = new AdbRuntimeBackend({
      adb: new AdbAdapter(runner),
      screenshots: fakeScreenshots(),
      annotatedScreens: {
        resolve: vi.fn(() => Promise.resolve({ x: 1, y: 2 }))
      },
      uiStability: {
        reset: vi.fn(),
        sample: vi.fn(() => Promise.resolve([]))
      },
      uiSnapshots: uiSnapshotFactory(uiSnapshotProvider())
    });
    await expect(backend.listDevices()).resolves.toEqual([
      { serial: "emulator-5554", status: "device" }
    ]);
  });
});
