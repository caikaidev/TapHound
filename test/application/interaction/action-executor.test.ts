import { describe, expect, it, vi } from "vitest";

import {
  ActionExecutor,
  type ActionTarget
} from "../../../src/application/interaction/action-executor.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import type { JourneyStep } from "../../../src/domain/journey.js";

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
    currentActivity: vi.fn(),
    pid: vi.fn(),
    tap: vi.fn(() => Promise.resolve(commandResult)),
    longClick: vi.fn(() => Promise.resolve(commandResult)),
    swipe: vi.fn(() => Promise.resolve(commandResult)),
    back: vi.fn(() => Promise.resolve(commandResult)),
    inputText: vi.fn(() => Promise.resolve(commandResult)),
    startLogcat: vi.fn()
  };
}

const target = {
  point: { x: 50, y: 100 },
  bounds: { left: 0, top: 0, right: 100, bottom: 200 }
};

describe("ActionExecutor", () => {
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
