import { describe, expect, it, vi } from "vitest";

import {
  ActionExecutor,
  type ActionTarget
} from "../../../src/application/interaction/action-executor.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import type { JourneyStep } from "../../../src/domain/journey.js";
import { commandResult } from "../../fakes/process-runner.js";

const checkpoint = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

function result(exitCode = 0): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: exitCode === 0 ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    cancelled: false
  };
}

function adbPort(commandResult = result()): AdbPort {
  return {
    devices: vi.fn(),
    foregroundComponent: vi.fn(),
    currentActivity: vi.fn(),
    isInstalled: vi.fn(),
    launchActivity: vi.fn(),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(),
    appProcesses: vi.fn(() => Promise.resolve([
      { pid: 42, name: "com.example.app" }
    ])),
    windowTopology: vi.fn(),
    tap: vi.fn(() => Promise.resolve(commandResult)),
    longClick: vi.fn(() => Promise.resolve(commandResult)),
    swipe: vi.fn(() => Promise.resolve(commandResult)),
    back: vi.fn(() => Promise.resolve(commandResult)),
    inputText: vi.fn(() => Promise.resolve(commandResult)),
    startLogcat: vi.fn(),
    dumpLogcat: vi.fn()
  };
}

const target = {
  point: { x: 50, y: 100 },
  bounds: { left: 0, top: 0, right: 100, bottom: 200 }
};

describe("ActionExecutor", () => {
  it("invalidates UI observations before mutation even when ADB fails", async () => {
    const adb = adbPort(result(1));
    const beforeMutation = vi.fn();
    const executor = new ActionExecutor(
      adb,
      "emulator-5554",
      beforeMutation
    );

    await executor.execute({
      action: "click",
      locator: { resourceId: "target" },
      activity: checkpoint
    }, { point: { x: 10, y: 20 } });

    expect(beforeMutation).toHaveBeenCalledOnce();
    const invalidationOrder = beforeMutation.mock.invocationCallOrder[0];
    const actionOrder = vi.mocked(adb.tap).mock.invocationCallOrder[0];
    expect(invalidationOrder).toBeDefined();
    expect(actionOrder).toBeDefined();
    if (invalidationOrder === undefined || actionOrder === undefined) {
      throw new Error("Expected mutation invalidation and ADB action calls");
    }
    expect(invalidationOrder).toBeLessThan(actionOrder);
  });
  it("executes click and longClick at the resolved point", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");

    await executor.execute({
      action: "click",
      locator: { resourceId: "search" },
      activity: checkpoint
    }, target);
    await executor.execute({
      action: "longClick",
      locator: { resourceId: "search" },
      durationMs: 800,
      activity: checkpoint
    }, target);

    expect(vi.mocked(adb.tap)).toHaveBeenCalledWith(
      target.point,
      "emulator-5554",
      undefined
    );
    expect(vi.mocked(adb.longClick)).toHaveBeenCalledWith(
      target.point,
      800,
      "emulator-5554",
      undefined
    );
  });

  it("executes inputText and Back without a target", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");

    await executor.execute({
      action: "inputText",
      text: "hello world",
      activity: checkpoint
    });
    await executor.execute({ action: "back", activity: checkpoint });

    expect(vi.mocked(adb.inputText)).toHaveBeenCalledWith(
      "hello world",
      "emulator-5554",
      undefined
    );
    expect(vi.mocked(adb.back)).toHaveBeenCalledWith(
      "emulator-5554",
      undefined
    );
  });

  it("converts an upward swipe to points inside the target bounds", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");

    await executor.execute({
      action: "swipe",
      locator: { resourceId: "results" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300,
      activity: checkpoint
    }, target);

    expect(vi.mocked(adb.swipe)).toHaveBeenCalledWith(
      { x: 50, y: 160 },
      { x: 50, y: 40 },
      300,
      "emulator-5554",
      undefined
    );
  });

  it("rejects swipe when Android CLI only exposes a center point", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");
    const centerOnly = {
      point: { x: 540, y: 1200 }
    } as ActionTarget;

    const execution = await executor.execute({
      action: "swipe",
      locator: { resourceId: "button" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300,
      activity: checkpoint
    }, centerOnly);

    expect(execution).toMatchObject({
      status: "failed",
      code: "ACTION_FAILED"
    });
    expect(execution.status === "failed" ? execution.message : "")
      .toMatch(/bounds/i);
    expect(vi.mocked(adb.swipe)).not.toHaveBeenCalled();
  });

  it("performs no ADB command for wait", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");

    await expect(executor.execute({
      action: "wait",
      activity: checkpoint
    })).resolves.toEqual({ status: "succeeded" });

    expect(vi.mocked(adb.tap)).not.toHaveBeenCalled();
    expect(vi.mocked(adb.swipe)).not.toHaveBeenCalled();
  });

  it("fails target-based Actions without a resolved target", async () => {
    const executor = new ActionExecutor(adbPort(), "emulator-5554");

    await expect(executor.execute({
      action: "click",
      locator: { resourceId: "search" },
      activity: checkpoint
    })).resolves.toMatchObject({
      status: "failed",
      code: "ACTION_FAILED"
    });
  });

  it("maps a nonzero ADB result to ACTION_FAILED", async () => {
    const executor = new ActionExecutor(adbPort(result(1)), "emulator-5554");
    const step: JourneyStep = {
      action: "back",
      activity: checkpoint
    };

    await expect(executor.execute(step)).resolves.toMatchObject({
      status: "failed",
      code: "ACTION_FAILED"
    });
  });
});

describe("scrollTo defensive case", () => {
  it("returns ACTION_FAILED because scrollTo is not executed here", async () => {
    const adb = adbPort();
    const executor = new ActionExecutor(adb, "emulator-5554");
    const outcome = await executor.execute({
      action: "scrollTo",
      locator: { resourceId: "x" },
      container: { resourceId: "list" },
      direction: "up",
      maxSwipes: 5,
      distancePercent: 0.6,
      durationMs: 300,
      activity: { before: "com.example.app.A", after: "com.example.app.A" }
    }, undefined);
    expect(outcome).toEqual({
      status: "failed",
      code: "ACTION_FAILED",
      message: "scrollTo is not executed via ActionExecutor"
    });
  });
});

describe("swipeBounds", () => {
  it("swipes within the given bounds and reports success", async () => {
    const swipe = vi.fn(() => Promise.resolve(commandResult()));
    const adb = { swipe } as unknown as AdbPort;
    const executor = new ActionExecutor(adb, "emulator-5554");
    const result = await executor.swipeBounds(
      { left: 0, top: 0, right: 100, bottom: 200 },
      "up",
      0.6,
      300
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(swipe).toHaveBeenCalledTimes(1);
    const [from, to] = swipe.mock.calls[0] as unknown as [
      { x: number; y: number },
      { x: number; y: number }
    ];
    expect(from.y).toBeGreaterThan(to.y);
  });
});
