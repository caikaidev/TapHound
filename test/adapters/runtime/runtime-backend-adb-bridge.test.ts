import { describe, expect, it, vi } from "vitest";

import { RuntimeBackendAdbBridge } from "../../../src/adapters/runtime/runtime-backend-adb-bridge.js";
import {
  FakeRuntimeBackend,
  fakeRuntimeCapabilities,
  fakeRuntimeUiSnapshotProvider
} from "../../../src/adapters/runtime/fake-runtime-backend.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { RuntimeBackend, RuntimeSession } from "../../../src/ports/runtime-backend.js";
import type { CommandResult, RunningCommand } from "../../../src/ports/process-runner.js";

function commandResult(): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false
  };
}

function mockSession(deviceSerial: string): RuntimeSession & {
  mocks: {
    isInstalled: ReturnType<typeof vi.fn>;
    launchApp: ReturnType<typeof vi.fn>;
    forceStop: ReturnType<typeof vi.fn>;
    currentActivity: ReturnType<typeof vi.fn>;
    foregroundComponent: ReturnType<typeof vi.fn>;
    appProcesses: ReturnType<typeof vi.fn>;
    windowTopology: ReturnType<typeof vi.fn>;
    tap: ReturnType<typeof vi.fn>;
    longClick: ReturnType<typeof vi.fn>;
    swipe: ReturnType<typeof vi.fn>;
    back: ReturnType<typeof vi.fn>;
    inputText: ReturnType<typeof vi.fn>;
    startLogcat: ReturnType<typeof vi.fn>;
    dumpLogcat: ReturnType<typeof vi.fn>;
    startActivityByIntent: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    isInstalled: vi.fn(() => Promise.resolve(true)),
    launchApp: vi.fn(() => Promise.resolve(commandResult())),
    forceStop: vi.fn(() => Promise.resolve(commandResult())),
    currentActivity: vi.fn(() => Promise.resolve("com.example.app.MainActivity")),
    foregroundComponent: vi.fn(() => Promise.resolve({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    })),
    appProcesses: vi.fn(() => Promise.resolve([
      { pid: 42, name: "com.example.app" }
    ])),
    windowTopology: vi.fn(() => Promise.resolve({
      version: 1 as const,
      status: "unavailable" as const,
      windows: [],
      diagnostic: "not required"
    })),
    tap: vi.fn(() => Promise.resolve(commandResult())),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn((): RunningCommand => ({
      started: Promise.resolve(undefined),
      completion: Promise.resolve(commandResult()),
      stop: vi.fn(() => Promise.resolve(commandResult()))
    })),
    dumpLogcat: vi.fn(() => Promise.resolve(commandResult())),
    startActivityByIntent: vi.fn(() => Promise.resolve(commandResult())),
    close: vi.fn(() => Promise.resolve())
  };
  const session: RuntimeSession = {
    descriptor: new FakeRuntimeBackend().descriptor,
    deviceSerial,
    openUiSnapshots: vi.fn(() => Promise.resolve(fakeRuntimeUiSnapshotProvider())),
    isInstalled: mocks.isInstalled,
    launchApp: mocks.launchApp,
    forceStop: mocks.forceStop,
    currentActivity: mocks.currentActivity,
    foregroundComponent: mocks.foregroundComponent,
    appProcesses: mocks.appProcesses,
    windowTopology: mocks.windowTopology,
    tap: mocks.tap,
    longClick: mocks.longClick,
    swipe: mocks.swipe,
    back: mocks.back,
    inputText: mocks.inputText,
    startLogcat: mocks.startLogcat,
    dumpLogcat: mocks.dumpLogcat,
    captureScreenshot: vi.fn(() => Promise.resolve(commandResult())),
    annotatedScreens: undefined,
    uiStability: {
      reset: vi.fn(),
      sample: vi.fn(() => Promise.resolve([]))
    },
    startActivityByIntent: mocks.startActivityByIntent,
    close: mocks.close
  };
  return Object.assign(session, { mocks });
}

function mockBackend(sessionFor: (
  deviceSerial: string
) => RuntimeSession): RuntimeBackend & {
  openSession: ReturnType<typeof vi.fn>;
  listDevices: ReturnType<typeof vi.fn>;
} {
  return {
    descriptor: sessionFor("emulator-5554").descriptor,
    capabilities: fakeRuntimeCapabilities(),
    listDevices: vi.fn(() => Promise.resolve([
      { serial: "emulator-5554", status: "device" },
      { serial: "emulator-5556", status: "device" }
    ])),
    openSession: vi.fn((options: { deviceSerial: string }) => (
      Promise.resolve(sessionFor(options.deviceSerial))
    ))
  };
}

function bridgeFixture(): {
  bridge: RuntimeBackendAdbBridge;
  adb: AdbPort;
  session: ReturnType<typeof mockSession>;
  backend: ReturnType<typeof mockBackend>;
} {
  const session = mockSession("emulator-5554");
  const backend = mockBackend((deviceSerial): RuntimeSession => (
    deviceSerial === "emulator-5554" ? session : mockSession(deviceSerial)
  ));
  const bridge = new RuntimeBackendAdbBridge({ backend });
  return { bridge, adb: bridge, session, backend };
}

describe("RuntimeBackendAdbBridge", () => {
  it("delegates device listing to the backend", async () => {
    const { adb, backend } = bridgeFixture();
    await expect(adb.devices()).resolves.toEqual([
      { serial: "emulator-5554", status: "device" },
      { serial: "emulator-5556", status: "device" }
    ]);
    expect(backend.listDevices).toHaveBeenCalledTimes(1);
  });

  it("opens one session per serial and reuses it", async () => {
    const { adb, backend } = bridgeFixture();
    await adb.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });
    await adb.tap({ x: 1, y: 2 }, "emulator-5554");
    expect(backend.openSession).toHaveBeenCalledTimes(1);
    await adb.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5556"
    });
    expect(backend.openSession).toHaveBeenCalledTimes(2);
    expect(backend.openSession).toHaveBeenNthCalledWith(1, {
      deviceSerial: "emulator-5554"
    });
    expect(backend.openSession).toHaveBeenNthCalledWith(2, {
      deviceSerial: "emulator-5556"
    });
  });

  it("retries the session open after a failure", async () => {
    const session = mockSession("emulator-5554");
    const backend = mockBackend(() => session);
    backend.openSession
      .mockReturnValueOnce(Promise.reject(new Error("device offline")))
      .mockReturnValueOnce(Promise.resolve(session));
    const bridge = new RuntimeBackendAdbBridge({ backend });
    await expect(bridge.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).rejects.toThrow("device offline");
    await expect(bridge.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe(true);
    expect(backend.openSession).toHaveBeenCalledTimes(2);
  });

  it("strips the device serial from app queries", async () => {
    const { adb, session } = bridgeFixture();
    const signal = new AbortController().signal;
    await adb.foregroundComponent({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      signal,
      timeoutMs: 250
    });
    expect(session.mocks.foregroundComponent).toHaveBeenCalledWith({
      packageName: "com.example.app",
      signal,
      timeoutMs: 250
    });
    await adb.appProcesses({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });
    expect(session.mocks.appProcesses).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await adb.windowTopology({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });
    expect(session.mocks.windowTopology).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await adb.currentActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });
    expect(session.mocks.currentActivity).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
  });

  it("maps launchActivity onto the session launch", async () => {
    const { adb, session } = bridgeFixture();
    const signal = new AbortController().signal;
    await adb.launchActivity({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      deviceSerial: "emulator-5554",
      signal,
      timeoutMs: 500
    });
    expect(session.mocks.launchApp).toHaveBeenCalledWith({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      signal,
      timeoutMs: 500
    });
    await adb.forceStop({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    });
    expect(session.mocks.forceStop).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
  });

  it("delegates actions without the serial parameter", async () => {
    const { adb, session } = bridgeFixture();
    const point = { x: 12, y: 34 };
    const signal = new AbortController().signal;
    await adb.tap(point, "emulator-5554", signal);
    expect(session.mocks.tap).toHaveBeenCalledWith(point, signal);
    await adb.longClick(point, 900, "emulator-5554");
    expect(session.mocks.longClick).toHaveBeenCalledWith(point, 900, undefined);
    await adb.swipe(point, { x: 12, y: 60 }, 400, "emulator-5554");
    expect(session.mocks.swipe).toHaveBeenCalledWith(
      point,
      { x: 12, y: 60 },
      400,
      undefined
    );
    await adb.back("emulator-5554");
    expect(session.mocks.back).toHaveBeenCalledWith(undefined);
    await adb.inputText("hello", "emulator-5554");
    expect(session.mocks.inputText).toHaveBeenCalledWith("hello", undefined);
  });

  it("delegates startLogcat through a lazy running command", async () => {
    const { adb, session } = bridgeFixture();
    const stop = vi.fn(() => Promise.resolve(commandResult()));
    const running: RunningCommand = {
      started: Promise.resolve(undefined),
      completion: Promise.resolve(commandResult()),
      stop
    };
    session.mocks.startLogcat.mockReturnValueOnce(running);
    const onStdoutLine = (): void => undefined;
    const onStderrLine = (): void => undefined;
    const signal = new AbortController().signal;
    const bridged = adb.startLogcat({
      deviceSerial: "emulator-5554",
      onStdoutLine,
      onStderrLine,
      signal
    });
    await expect(bridged.started).resolves.toBeUndefined();
    expect(session.mocks.startLogcat).toHaveBeenCalledWith({
      onStdoutLine,
      onStderrLine,
      signal
    });
    await expect(bridged.completion).resolves.toEqual(commandResult());
    await bridged.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("delegates dumpLogcat with the serial stripped", async () => {
    const { adb, session } = bridgeFixture();
    await adb.dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 200,
      timeoutMs: 1000
    });
    expect(session.mocks.dumpLogcat).toHaveBeenCalledWith({
      maxLines: 200,
      timeoutMs: 1000
    });
  });

  it("delegates startActivityByIntent when the session supports it", async () => {
    const { adb, session } = bridgeFixture();
    await adb.startActivityByIntent({
      action: "android.media.action.IMAGE_CAPTURE",
      deviceSerial: "emulator-5554"
    });
    expect(session.mocks.startActivityByIntent).toHaveBeenCalledWith({
      action: "android.media.action.IMAGE_CAPTURE"
    });
  });

  it("rejects startActivityByIntent with a coded capability error", async () => {
    const session = mockSession("emulator-5554");
    const sessionWithoutIntent: RuntimeSession = {
      ...session,
      startActivityByIntent: undefined
    };
    const backend = mockBackend(() => sessionWithoutIntent);
    const bridge = new RuntimeBackendAdbBridge({ backend });
    const error = await bridge.startActivityByIntent({
      action: "android.media.action.IMAGE_CAPTURE",
      deviceSerial: "emulator-5554"
    }).then(
      () => undefined,
      (rethrown: unknown): unknown => rethrown
    );
    expect(error).toMatchObject({
      code: "RUNTIME_CAPABILITY_MISSING"
    });
    expect((error as Error).message)
      .toContain('does not support startActivityByIntent');
    expect((error as Error).message).toContain("TAPHOUND_RUNTIME_BACKEND");
  });

  it("fails closed on resolveLauncherActivity", async () => {
    const { adb } = bridgeFixture();
    await expect(adb.resolveLauncherActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).rejects.toThrow(/resolveLauncherActivity is not available/);
  });

  it("closes every cached session and reopens after close", async () => {
    const { adb, backend, session } = bridgeFixture();
    await adb.tap({ x: 1, y: 2 }, "emulator-5554");
    await adb.tap({ x: 1, y: 2 }, "emulator-5556");
    const bridge = adb as RuntimeBackendAdbBridge;
    await bridge.close();
    expect(session.mocks.close).toHaveBeenCalledTimes(1);
    expect(backend.openSession).toHaveBeenCalledTimes(2);
    await adb.back("emulator-5554");
    expect(backend.openSession).toHaveBeenCalledTimes(3);
  });});
