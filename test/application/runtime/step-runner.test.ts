import { describe, expect, it, vi } from "vitest";

import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import {
  StepRunner,
  type StepRunnerOptions
} from "../../../src/application/runtime/step-runner.js";
import type { JourneyStep } from "../../../src/domain/journey.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import { MemoryArtifactSession } from "../../fakes/artifact-store.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import {
  commandResult,
  runningCommand
} from "../../fakes/process-runner.js";

const checkpoint = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.SearchActivity"
};

function adbPort(): AdbPort {
  return {
    devices: vi.fn(),
    currentActivity: vi.fn()
      .mockResolvedValueOnce(checkpoint.before)
      .mockResolvedValueOnce(checkpoint.after),
    pid: vi.fn(() => Promise.resolve(42)),
    tap: vi.fn(() => Promise.resolve(commandResult())),
    longClick: vi.fn(() => Promise.resolve(commandResult())),
    swipe: vi.fn(() => Promise.resolve(commandResult())),
    back: vi.fn(() => Promise.resolve(commandResult())),
    inputText: vi.fn(() => Promise.resolve(commandResult())),
    startLogcat: vi.fn(() => runningCommand())
  };
}

function androidCli(): AndroidCliPort {
  return {
    describeProject: vi.fn(),
    runApp: vi.fn(),
    layout: vi.fn(() => Promise.resolve([{
      id: "search",
      resourceId: "search",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    }])),
    layoutDiff: vi.fn(() => Promise.resolve([])),
    captureScreen: vi.fn(() => Promise.resolve(commandResult())),
    resolveScreen: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
  };
}

function fixture(overrides: {
  adb?: AdbPort;
  androidCli?: AndroidCliPort;
  idle?: StepRunnerOptions["idle"];
} = {}): {
  runner: StepRunner;
  adb: AdbPort;
  androidCli: AndroidCliPort;
  clock: FakeClock;
  artifacts: MemoryArtifactSession;
  logcat: LogcatCollector;
} {
  const adb = overrides.adb ?? adbPort();
  const cli = overrides.androidCli ?? androidCli();
  const clock = new FakeClock();
  const artifacts = new MemoryArtifactSession();
  const logcat = new LogcatCollector(adb, clock);
  void logcat.start({ deviceSerial: "emulator-5554" });
  logcat.scopeToPid(42);
  return {
    runner: new StepRunner({
      adb,
      androidCli: cli,
      clock,
      logcat,
      artifacts,
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      idle: overrides.idle ?? {
        pollIntervalMs: 100,
        stablePolls: 1,
        timeoutMs: 500
      }
    }),
    adb,
    androidCli: cli,
    clock,
    artifacts,
    logcat
  };
}

function clickStep(): Extract<JourneyStep, { action: "click" }> {
  return {
    action: "click",
    locator: { resourceId: "search" },
    activity: checkpoint
  };
}

const scrollStep: JourneyStep = {
  action: "scrollTo",
  locator: { resourceId: "message_bubble", text: "target" },
  container: { resourceId: "message_list" },
  direction: "up",
  maxSwipes: 3,
  distancePercent: 0.6,
  durationMs: 300,
  activity: {
    before: "com.example.app.MainActivity",
    after: "com.example.app.MainActivity"
  }
};

function scrollCli(target: "present" | "afterOneSwipe" | "absent"): AndroidCliPort {
  const container = {
    id: "message_list",
    resourceId: "message_list",
    scrollable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 400 },
    children: []
  };
  const bubble = {
    id: "message_bubble",
    resourceId: "message_bubble",
    text: "target",
    enabled: true,
    bounds: { left: 0, top: 100, right: 100, bottom: 150 },
    children: []
  };
  let reads = 0;
  return {
    describeProject: vi.fn(),
    runApp: vi.fn(),
    layout: vi.fn(() => {
      reads += 1;
      const withBubble = [container, bubble];
      const withoutBubble = [container];
      if (target === "present") return Promise.resolve(withBubble);
      if (target === "absent") return Promise.resolve(withoutBubble);
      return Promise.resolve(reads >= 2 ? withBubble : withoutBubble);
    }),
    layoutDiff: vi.fn(() => Promise.resolve([])),
    captureScreen: vi.fn(() => Promise.resolve(commandResult())),
    resolveScreen: vi.fn(() => Promise.resolve({ x: 50, y: 25 }))
  };
}

function mainActivityAdb(): AdbPort {
  const adb = adbPort();
  adb.currentActivity = vi.fn(() =>
    Promise.resolve("com.example.app.MainActivity"));
  return adb;
}

describe("StepRunner", () => {
  it("executes the complete successful step flow", async () => {
    const test = fixture();

    const result = await test.runner.run(clickStep(), 0);

    expect(result).toMatchObject({
      status: "passed",
      report: {
        index: 0,
        action: "click",
        status: "passed",
        locator: {
          status: "found",
          matchedBy: "resourceId",
          fallbackUsed: false
        },
        idle: { status: "stable", polls: 1 },
        activity: {
          before: { status: "passed", actual: checkpoint.before },
          after: { status: "passed", actual: checkpoint.after }
        },
        logcatPath: "steps/001-logcat.txt"
      }
    });
    expect(vi.mocked(test.adb.tap)).toHaveBeenCalledWith(
      { x: 50, y: 25 },
      "emulator-5554",
      undefined
    );
    expect(test.artifacts.text.has("steps/001-logcat.txt")).toBe(true);
  });

  it("fails before locating when the source Activity is wrong", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity).mockReset();
    vi.mocked(adb.currentActivity).mockResolvedValue("com.example.app.OtherActivity");
    const test = fixture({ adb });

    const result = await test.runner.run(clickStep(), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "ACTIVITY_BEFORE_MISMATCH" }
    });
    expect(test.androidCli.layout).not.toHaveBeenCalled();
    expect(adb.tap).not.toHaveBeenCalled();
  });

  it("reports a missing Locator without executing the Action", async () => {
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([]);
    const test = fixture({ androidCli: cli });

    const result = await test.runner.run(clickStep(), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "LOCATOR_NOT_FOUND" }
    });
    expect(test.adb.tap).not.toHaveBeenCalled();
  });

  it("uses explicit annotated-label fallback and records evidence", async () => {
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([]);
    const test = fixture({ androidCli: cli });
    const step: JourneyStep = {
      ...clickStep(),
      fallback: { type: "annotatedLabel", label: "#7" }
    };

    const result = await test.runner.run(step, 0);

    expect(result).toMatchObject({
      status: "passed",
      report: {
        locator: {
          status: "found",
          fallbackUsed: true,
          fallbackLabel: "#7",
          annotatedScreenshotPath: "steps/001-fallback-annotated.png"
        }
      }
    });
    expect(test.adb.tap).toHaveBeenCalledWith(
      { x: 50, y: 25 },
      "emulator-5554",
      undefined
    );
  });

  it("keeps annotated fallback evidence when label resolution fails", async () => {
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([]);
    vi.mocked(cli.resolveScreen).mockRejectedValue(
      new Error("label is missing from the annotated screen")
    );
    const test = fixture({ androidCli: cli });
    const step: JourneyStep = {
      ...clickStep(),
      fallback: { type: "annotatedLabel", label: "#7" }
    };

    const result = await test.runner.run(step, 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "LOCATOR_NOT_FOUND" },
      report: {
        locator: {
          status: "failed",
          fallbackUsed: true,
          fallbackLabel: "#7",
          annotatedScreenshotPath: "steps/001-fallback-annotated.png"
        }
      }
    });
  });

  it("stops at an Action failure", async () => {
    const adb = adbPort();
    vi.mocked(adb.tap).mockResolvedValue(commandResult({
      exitCode: 1,
      stderr: "tap failed"
    }));
    const test = fixture({ adb });

    await expect(test.runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTION_FAILED", message: "tap failed" }
    });
    expect(test.androidCli.layoutDiff).not.toHaveBeenCalled();
  });

  it("records the last Layout Diff at idle timeout", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff).mockResolvedValue([{ changed: "text" }]);
    const test = fixture({
      androidCli: cli,
      idle: {
        pollIntervalMs: 100,
        stablePolls: 2,
        timeoutMs: 100
      }
    });

    const result = await test.runner.run(clickStep(), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "IDLE_TIMEOUT" },
      report: { idle: { status: "timeout" } }
    });
    expect(test.artifacts.json.get("steps/001-layout-diff.json"))
      .toEqual([{ changed: "text" }]);
  });

  it("detects an App crash after the Action", async () => {
    const adb = adbPort();
    vi.mocked(adb.pid).mockResolvedValue(null);
    const test = fixture({ adb });

    await expect(test.runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "APP_CRASHED" }
    });
  });

  it("reports a destination Activity mismatch", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity).mockReset();
    vi.mocked(adb.currentActivity)
      .mockResolvedValueOnce(checkpoint.before)
      .mockResolvedValueOnce("com.example.app.OtherActivity");
    const test = fixture({ adb });

    await expect(test.runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTIVITY_AFTER_MISMATCH" }
    });
  });

  it("runs and reports an explicit Expect after checkpoints", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity).mockReset();
    vi.mocked(adb.currentActivity)
      .mockResolvedValueOnce(checkpoint.before)
      .mockResolvedValueOnce(checkpoint.after)
      .mockResolvedValue("com.example.app.OtherActivity");
    const test = fixture({ adb });
    const step: JourneyStep = {
      ...clickStep(),
      expect: {
        type: "activity",
        value: "com.example.app.ExpectedActivity",
        timeoutMs: 100
      }
    };

    const result = await test.runner.run(step, 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "EXPECT_ACTIVITY_FAILED" },
      report: {
        expectation: {
          type: "activity",
          status: "failed",
          code: "EXPECT_ACTIVITY_FAILED"
        }
      }
    });
  });
});

describe("scrollTo replay", () => {
  it("passes without swiping when the target is already visible", async () => {
    const { runner, adb } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("present")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("passed");
    expect(result.report.scroll).toEqual({ swipesUsed: 0, maxSwipes: 3 });
    expect(adb.swipe).not.toHaveBeenCalled();
  });

  it("swipes until the target becomes visible", async () => {
    const { runner, adb } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("afterOneSwipe")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("passed");
    expect(result.report.scroll).toEqual({ swipesUsed: 1, maxSwipes: 3 });
    expect(adb.swipe).toHaveBeenCalledTimes(1);
  });

  it("fails with SCROLL_TARGET_NOT_FOUND when the bound is exhausted", async () => {
    const { runner } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("absent")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("SCROLL_TARGET_NOT_FOUND");
    }
    expect(result.report.scroll).toEqual({ swipesUsed: 3, maxSwipes: 3 });
  });
});
