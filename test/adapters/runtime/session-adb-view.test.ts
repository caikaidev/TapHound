import { describe, expect, it, vi } from "vitest";

import {
  RuntimeSessionAdbView,
  SessionBoundScreenshotAdapter,
  runtimeSessionPortViews
} from "../../../src/adapters/runtime/session-adb-view.js";
import { adbRuntimeCapabilities } from "../../../src/adapters/runtime/adb-runtime-backend.js";
import type { AnnotatedScreenResolverPort } from "../../../src/ports/annotated-screen-resolver.js";
import type { RuntimeSession } from "../../../src/ports/runtime-backend.js";
import type {
  CommandResult,
  RunningCommand
} from "../../../src/ports/process-runner.js";
import type { UiStabilityProbe } from "../../../src/ports/ui-stability.js";
import { commandResult } from "../../fakes/process-runner.js";

interface SessionMocks {
  openUiSnapshots: RuntimeSession["openUiSnapshots"];
  isInstalled: RuntimeSession["isInstalled"];
  launchApp: RuntimeSession["launchApp"];
  forceStop: RuntimeSession["forceStop"];
  currentActivity: NonNullable<RuntimeSession["currentActivity"]>;
  foregroundComponent: NonNullable<RuntimeSession["foregroundComponent"]>;
  appProcesses: NonNullable<RuntimeSession["appProcesses"]>;
  windowTopology: NonNullable<RuntimeSession["windowTopology"]>;
  tap: RuntimeSession["tap"];
  longClick: RuntimeSession["longClick"];
  swipe: RuntimeSession["swipe"];
  back: RuntimeSession["back"];
  inputText: RuntimeSession["inputText"];
  startLogcat: NonNullable<RuntimeSession["startLogcat"]>;
  dumpLogcat: NonNullable<RuntimeSession["dumpLogcat"]>;
  captureScreenshot: RuntimeSession["captureScreenshot"];
  startActivityByIntent: NonNullable<RuntimeSession["startActivityByIntent"]>;
  close: RuntimeSession["close"];
}

function runningCommand(): RunningCommand & {
  stop: ReturnType<typeof vi.fn>;
} {
  const completion = Promise.resolve(commandResult());
  return {
    started: Promise.resolve(undefined),
    completion,
    stop: vi.fn(() => completion)
  };
}

function fakeSession(overrides: Partial<RuntimeSession> = {}): {
  session: RuntimeSession;
  mocks: SessionMocks;
} {
  const mocks: SessionMocks = {
    openUiSnapshots: vi.fn(),
    isInstalled: vi.fn(() => Promise.resolve(true)),
    launchApp: vi.fn(() => Promise.resolve(commandResult())),
    forceStop: vi.fn(() => Promise.resolve(commandResult())),
    currentActivity: vi.fn(() =>
      Promise.resolve("com.example.app.MainActivity")
    ),
    foregroundComponent: vi.fn(),
    appProcesses: vi.fn(() => Promise.resolve([])),
    windowTopology: vi.fn(),
    tap: vi.fn(() => Promise.resolve(commandResult())),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn(() => runningCommand()),
    dumpLogcat: vi.fn(() => Promise.resolve(commandResult())),
    captureScreenshot: vi.fn(() => Promise.resolve(commandResult())),
    startActivityByIntent: vi.fn(() => Promise.resolve(commandResult())),
    close: vi.fn(() => Promise.resolve(undefined))
  };
  const annotatedScreens: AnnotatedScreenResolverPort = {
    resolve: vi.fn(() => Promise.resolve({ x: 12, y: 34 }))
  };
  const uiStability: UiStabilityProbe = {
    reset: vi.fn(),
    sample: vi.fn(() => Promise.resolve([]))
  };
  const session: RuntimeSession = {
    descriptor: {
      id: "adb",
      adapterVersion: "test-v1",
      configSha256: "0".repeat(64),
      capabilities: adbRuntimeCapabilities()
    },
    deviceSerial: "emulator-5554",
    openUiSnapshots: mocks.openUiSnapshots,
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
    captureScreenshot: mocks.captureScreenshot,
    annotatedScreens,
    uiStability,
    startActivityByIntent: mocks.startActivityByIntent,
    close: mocks.close
  };
  return { session: Object.assign(session, overrides), mocks };
}

function capabilityError(error: unknown): void {
  expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
}

const IDENTITY = {
  packageName: "com.example.app",
  deviceSerial: "emulator-5554"
};

describe("RuntimeSessionAdbView", () => {
  it("forwards app lifecycle calls with the bound serial stripped", async () => {
    const { session, mocks } = fakeSession();
    const view = new RuntimeSessionAdbView(session);

    await expect(view.isInstalled(IDENTITY)).resolves.toBe(true);
    expect(mocks.isInstalled).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await view.launchActivity({
      packageName: "com.example.app",
      activity: ".MainActivity",
      deviceSerial: "emulator-5554",
      timeoutMs: 250
    });
    expect(mocks.launchApp).toHaveBeenCalledWith({
      packageName: "com.example.app",
      activity: ".MainActivity",
      timeoutMs: 250
    });
    await view.forceStop(IDENTITY);
    expect(mocks.forceStop).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
  });

  it("forwards optional signal and timeout fields", async () => {
    const controller = new AbortController();
    const { session, mocks } = fakeSession();
    const view = new RuntimeSessionAdbView(session);

    await view.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      signal: controller.signal,
      timeoutMs: 900
    });
    expect(mocks.isInstalled).toHaveBeenCalledWith({
      packageName: "com.example.app",
      signal: controller.signal,
      timeoutMs: 900
    });
  });

  it("forwards deterministic actions without the serial", async () => {
    const controller = new AbortController();
    const { session, mocks } = fakeSession();
    const view = new RuntimeSessionAdbView(session);

    await view.tap({ x: 10, y: 20 }, "emulator-5554", controller.signal);
    expect(mocks.tap).toHaveBeenCalledWith(
      { x: 10, y: 20 },
      controller.signal
    );
    await view.longClick({ x: 1, y: 2 }, 500, "emulator-5554");
    expect(mocks.longClick).toHaveBeenCalledWith(
      { x: 1, y: 2 },
      500,
      undefined
    );
    await view.swipe({ x: 0, y: 0 }, { x: 5, y: 5 }, 100, "emulator-5554");
    expect(mocks.swipe).toHaveBeenCalledWith(
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      100,
      undefined
    );
    await view.back("emulator-5554");
    expect(mocks.back).toHaveBeenCalledWith(undefined);
    await view.inputText("hello", "emulator-5554");
    expect(mocks.inputText).toHaveBeenCalledWith("hello", undefined);
  });

  it("forwards capability-gated state members when present", async () => {
    const { session, mocks } = fakeSession();
    const view = new RuntimeSessionAdbView(session);

    await view.currentActivity(IDENTITY);
    expect(mocks.currentActivity).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await view.appProcesses(IDENTITY);
    expect(mocks.appProcesses).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await view.windowTopology(IDENTITY);
    expect(mocks.windowTopology).toHaveBeenCalledWith({
      packageName: "com.example.app"
    });
    await view.dumpLogcat({ deviceSerial: "emulator-5554", maxLines: 25 });
    expect(mocks.dumpLogcat).toHaveBeenCalledWith({ maxLines: 25 });
    await view.startActivityByIntent({
      deviceSerial: "emulator-5554",
      action: "android.media.action.IMAGE_CAPTURE"
    });
    expect(mocks.startActivityByIntent).toHaveBeenCalledWith({
      action: "android.media.action.IMAGE_CAPTURE"
    });
  });

  it("wraps startLogcat and chains stop to the session command", async () => {
    const running = runningCommand();
    const { session, mocks } = fakeSession();
    vi.mocked(mocks.startLogcat).mockReturnValue(running);
    const view = new RuntimeSessionAdbView(session);

    const onStdoutLine = (): void => undefined;
    const wrapped = view.startLogcat({
      deviceSerial: "emulator-5554",
      onStdoutLine
    });
    expect(mocks.startLogcat).toHaveBeenCalledWith({ onStdoutLine });
    expect(wrapped.started).toBe(running.started);
    expect(wrapped.completion).toBe(running.completion);
    const stopped: CommandResult = await wrapped.stop();
    expect(stopped.exitCode).toBe(0);
    expect(running.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed on every capability member the session lacks", async () => {
    const { session } = fakeSession({
      foregroundComponent: undefined,
      currentActivity: undefined,
      appProcesses: undefined,
      windowTopology: undefined,
      startLogcat: undefined,
      dumpLogcat: undefined,
      startActivityByIntent: undefined
    });
    const view = new RuntimeSessionAdbView(session);

    const foreground = await view.foregroundComponent(IDENTITY).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(foreground);
    const activity = await view.currentActivity(IDENTITY).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(activity);
    const processes = await view.appProcesses(IDENTITY).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(processes);
    const topology = await view.windowTopology(IDENTITY).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(topology);
    const dumped = await view.dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 5
    }).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(dumped);
    const intent = await view.startActivityByIntent({
      deviceSerial: "emulator-5554",
      action: "test.action.VIEW"
    }).then(
      () => undefined,
      (error: unknown): unknown => error
    );
    capabilityError(intent);
    expect(() => view.startLogcat({
      deviceSerial: "emulator-5554",
      onStdoutLine: () => undefined
    })).toThrow("does not support startLogcat");
    expect(() => view.startLogcat({
      deviceSerial: "emulator-5554",
      onStdoutLine: () => undefined
    })).toThrow("TAPHOUND_RUNTIME_BACKEND");
  });

  it("rejects calls for any other device serial", async () => {
    const { session } = fakeSession();
    const view = new RuntimeSessionAdbView(session);

    await expect(view.isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-9999"
    })).rejects.toThrow('cannot serve device "emulator-9999"');
    await expect(view.tap({ x: 1, y: 1 }, "emulator-9999"))
      .rejects.toThrow('bound to "emulator-5554"');
    expect(() => view.startLogcat({
      deviceSerial: "emulator-9999",
      onStdoutLine: () => undefined
    })).toThrow('bound to "emulator-5554"');
  });

  it("rejects device discovery and launcher resolution", async () => {
    const view = new RuntimeSessionAdbView(fakeSession().session);

    await expect(view.devices()).rejects.toThrow("Device discovery");
    await expect(view.resolveLauncherActivity())
      .rejects.toThrow("not available through the runtime backend SPI");
  });
});

describe("SessionBoundScreenshotAdapter", () => {
  it("captures through the session for the bound serial", async () => {
    const { session, mocks } = fakeSession();
    const adapter = new SessionBoundScreenshotAdapter(session);

    await adapter.capture({
      outputPath: "/tmp/shot.png",
      deviceSerial: "emulator-5554"
    });
    expect(mocks.captureScreenshot).toHaveBeenCalledWith({
      outputPath: "/tmp/shot.png"
    });
  });

  it("rejects captures for any other device serial", async () => {
    const adapter = new SessionBoundScreenshotAdapter(fakeSession().session);

    await expect(adapter.capture({
      outputPath: "/tmp/shot.png",
      deviceSerial: "emulator-9999"
    })).rejects.toThrow('cannot serve device "emulator-9999"');
  });
});

describe("runtimeSessionPortViews", () => {
  it("exposes the session's resolver and stability probe", () => {
    const { session } = fakeSession();
    const views = runtimeSessionPortViews(session);

    expect(views.adb).toBeInstanceOf(RuntimeSessionAdbView);
    expect(views.screenshots).toBeInstanceOf(SessionBoundScreenshotAdapter);
    expect(views.annotatedScreens).toBe(session.annotatedScreens);
    expect(views.uiStability).toBe(session.uiStability);
  });

  it("fails closed on annotated screens when the session lacks them", async () => {
    const { session } = fakeSession({ annotatedScreens: undefined });
    const views = runtimeSessionPortViews(session);

    const error = await views.annotatedScreens.resolve("/tmp/s.png", "Done")
      .then(
        () => undefined,
        (rethrown: unknown): unknown => rethrown
      );
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain("annotated screens");
  });
});
