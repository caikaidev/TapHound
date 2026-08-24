import { describe, expect, it, vi } from "vitest";

import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import {
  StepRunner,
  type StepRunnerOptions
} from "../../../src/application/runtime/step-runner.js";
import type { JourneyStep } from "../../../src/domain/journey.js";
import {
  locatorEvidenceForElement
} from "../../../src/domain/locator-evidence.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import type { AppProcess } from "../../../src/domain/app-process.js";
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

const alive: readonly AppProcess[] = [
  { pid: 42, name: "com.example.app" }
];

function adbPort(): AdbPort {
  return {
    devices: vi.fn(),
    foregroundComponent: vi.fn(),
    currentActivity: vi.fn()
      .mockResolvedValueOnce(checkpoint.before)
      .mockResolvedValueOnce(checkpoint.after),
    isInstalled: vi.fn(() => Promise.resolve(true)),
    launchActivity: vi.fn(() => Promise.resolve(commandResult())),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(),
    appProcesses: vi.fn(() => Promise.resolve(alive)),
    windowTopology: vi.fn(),
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
  requireFocusedInput?: boolean;
  generatedReplayPolicy?: boolean;
  manualReplay?: boolean;
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
  logcat.scopeToPids([42]);
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
      },
      ...(overrides.requireFocusedInput === undefined
        ? {}
        : { requireFocusedInput: overrides.requireFocusedInput }),
      ...(overrides.generatedReplayPolicy === undefined
        ? {}
        : { generatedReplayPolicy: overrides.generatedReplayPolicy }),
      ...(overrides.manualReplay === undefined
        ? {}
        : { manualReplay: overrides.manualReplay })
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

function scrollCli(
  target:
    | "present"
    | "afterOneSwipe"
    | "absent"
    | "idleTimeout"
    | "ambiguous"
    | "containerMissing"
): AndroidCliPort {
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
    layout: vi.fn(() => {
      reads += 1;
      if (target === "ambiguous") {
        return Promise.resolve([
          bubble,
          { ...bubble, id: "message_bubble_2", bounds: { left: 0, top: 200, right: 100, bottom: 250 } }
        ]);
      }
      if (target === "containerMissing") {
        return Promise.resolve([{
          id: "unrelated",
          resourceId: "unrelated",
          enabled: true,
          bounds: { left: 0, top: 0, right: 50, bottom: 50 },
          children: []
        }]);
      }
      const withBubble = [container, bubble];
      const withoutBubble = [container];
      if (target === "present") return Promise.resolve(withBubble);
      if (target === "absent" || target === "idleTimeout") {
        return Promise.resolve(withoutBubble);
      }
      return Promise.resolve(reads >= 2 ? withBubble : withoutBubble);
    }),
    layoutDiff: vi.fn(() =>
      Promise.resolve(target === "idleTimeout" ? [{ changed: "text" }] : [])
    ),
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
        idle: {
          status: "stable",
          polls: 3,
          strategy: "hybrid",
          fallbackUsed: false
        },
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

  it("does not bypass indexed evidence mismatch with annotated fallback", async () => {
    const original = {
      id: "original",
      resourceId: "row",
      text: "Same",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: [{
        id: "content",
        text: "Original",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }]
    };
    const cli = androidCli();
    cli.layout = vi.fn(() => Promise.resolve([{
      ...original,
      id: "replacement",
      children: [{
        id: "content",
        text: "Different",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }]
    }]));
    const test = fixture({ androidCli: cli });

    const failedResult = await test.runner.run({
      ...clickStep(),
      locator: {
        resourceId: "row",
        text: "Same",
        index: 0,
        evidence: locatorEvidenceForElement(original)
      },
      fallback: { type: "annotatedLabel", label: "#1" }
    }, 0);
    expect(failedResult).toMatchObject({
      status: "failed",
      failure: { code: "LOCATOR_NOT_FOUND" },
      report: {
        locator: {
          status: "failed",
          fallbackUsed: false
        }
      }
    });
    if (failedResult.status !== "failed") {
      throw new Error("Expected evidence mismatch failure");
    }
    expect(failedResult.failure.message).toMatch(/evidence/i);
    expect(vi.mocked(cli.resolveScreen)).not.toHaveBeenCalled();
    expect(vi.mocked(test.adb.tap)).not.toHaveBeenCalled();
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
    vi.mocked(adb.appProcesses).mockResolvedValue([]);
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

  it("fails with IDLE_TIMEOUT and writes layout-diff when idle times out during a scroll swipe", async () => {
    const { runner, artifacts } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("idleTimeout")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("IDLE_TIMEOUT");
    }
    expect(result.report.idle?.status).toBe("timeout");
    expect(result.report.scroll).toEqual({ swipesUsed: 0, maxSwipes: 3 });
    expect(artifacts.json.get("steps/001-layout-diff.json"))
      .toEqual([{ changed: "text" }]);
  });

  it("fails with LOCATOR_AMBIGUOUS when the target matches multiple elements", async () => {
    const { runner, adb } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("ambiguous")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("LOCATOR_AMBIGUOUS");
    }
    expect(adb.swipe).not.toHaveBeenCalled();
    expect(result.report.scroll?.swipesUsed).toBe(0);
  });

  it("fails with LOCATOR_NOT_FOUND when the container is missing", async () => {
    const { runner, adb } = fixture({
      adb: mainActivityAdb(),
      androidCli: scrollCli("containerMissing")
    });
    const result = await runner.run(scrollStep, 0);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("LOCATOR_NOT_FOUND");
    }
    expect(adb.swipe).not.toHaveBeenCalled();
  });

  it("requires exactly one enabled focused element for generated input replay", async () => {
    const cli = androidCli();
    const { runner, adb } = fixture({
      androidCli: cli,
      requireFocusedInput: true
    });
    const result = await runner.run({
      action: "inputText",
      text: "hello",
      activity: checkpoint
    }, 0);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("ACTION_FAILED");
      expect(result.failure.message).toContain("exactly one enabled focused");
    }
    expect(adb.inputText).not.toHaveBeenCalled();
  });

  it("keeps ordinary input replay behavior unchanged", async () => {
    const { runner, adb } = fixture();
    const result = await runner.run({
      action: "inputText",
      text: "hello",
      activity: checkpoint
    }, 0);

    expect(result.status).toBe("passed");
    expect(adb.inputText).toHaveBeenCalledOnce();
  });

  it("blocks generated click replay when the foreground package is foreign", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent).mockResolvedValue({
      packageName: "com.foreign.app",
      activity: checkpoint.before
    });
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTIVITY_BEFORE_MISMATCH" }
    });
    expect(adb.currentActivity).not.toHaveBeenCalled();
    expect(adb.tap).not.toHaveBeenCalled();
  });

  it("sandwiches generated target Layout capture before click mutation", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent)
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.foreign.app",
        activity: checkpoint.before
      });
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTIVITY_BEFORE_MISMATCH" }
    });
    expect(adb.tap).not.toHaveBeenCalled();
  });

  it("detects generated package escape after click and idle", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent)
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.foreign.app",
        activity: checkpoint.after
      });
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run(clickStep(), 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTIVITY_AFTER_MISMATCH" }
    });
    expect(adb.tap).toHaveBeenCalledOnce();
  });

  it("rejects a foreign package seen only during generated Activity Expect", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent)
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.after
      })
      .mockResolvedValueOnce({
        packageName: "com.foreign.app",
        activity: checkpoint.after
      })
      .mockResolvedValue({
        packageName: "com.example.app",
        activity: checkpoint.after
      });
    vi.mocked(adb.currentActivity).mockResolvedValue(checkpoint.after);
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "activity",
        value: checkpoint.after,
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Generated Expect foreground changed to com.foreign.app/com.example.app.SearchActivity"
      }
    });
    expect(adb.currentActivity).not.toHaveBeenCalled();
  });

  it("lets a generated Activity Expect poll from checkpoint A to expected B", async () => {
    const adb = adbPort();
    let actionCompleted = false;
    let postActionObservations = 0;
    vi.mocked(adb.tap).mockImplementationOnce(() => {
      actionCompleted = true;
      return Promise.resolve(commandResult());
    });
    vi.mocked(adb.foregroundComponent).mockImplementation(() => {
      const observation = actionCompleted ? ++postActionObservations : 0;
      return Promise.resolve({
        packageName: "com.example.app",
        activity: observation >= 3
          ? "com.example.app.ResultsActivity"
          : (
              actionCompleted
                ? checkpoint.after
                : checkpoint.before
            )
      });
    });
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "activity",
        value: "com.example.app.ResultsActivity",
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "passed",
      report: {
        expectation: {
          type: "activity",
          status: "passed"
        }
      }
    });
    expect(postActionObservations).toBe(4);
  });

  it("keeps a persistent foreign Activity Expect failure as EXPECT_ACTIVITY_FAILED", async () => {
    const adb = adbPort();
    let actionCompleted = false;
    let postActionObservations = 0;
    vi.mocked(adb.tap).mockImplementationOnce(() => {
      actionCompleted = true;
      return Promise.resolve(commandResult());
    });
    vi.mocked(adb.foregroundComponent).mockImplementation(() => {
      const observation = actionCompleted ? ++postActionObservations : 0;
      return Promise.resolve({
        packageName: observation >= 2
          ? "com.foreign.app"
          : "com.example.app",
        activity: observation >= 2
          ? "com.example.app.ResultsActivity"
          : (
              actionCompleted
                ? checkpoint.after
                : checkpoint.before
            )
      });
    });
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "activity",
        value: "com.example.app.ResultsActivity",
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Generated Expect foreground changed to com.foreign.app/com.example.app.ResultsActivity"
      }
    });
  });

  it("keeps a persistent Activity Expect PID replacement as EXPECT_ACTIVITY_FAILED", async () => {
    const adb = adbPort();
    let actionCompleted = false;
    let postActionPidObservations = 0;
    vi.mocked(adb.tap).mockImplementationOnce(() => {
      actionCompleted = true;
      return Promise.resolve(commandResult());
    });
    vi.mocked(adb.foregroundComponent).mockImplementation(() => (
      Promise.resolve({
        packageName: "com.example.app",
        activity: actionCompleted ? checkpoint.after : checkpoint.before
      })
    ));
    vi.mocked(adb.appProcesses).mockImplementation(() => Promise.resolve(
      [{ pid: actionCompleted && ++postActionPidObservations >= 2 ? 99 : 42, name: "com.example.app" }]
    ));
    const { runner } = fixture({ adb, generatedReplayPolicy: true });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "activity",
        value: "com.example.app.ResultsActivity",
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ACTIVITY_FAILED",
        message: "Generated Expect process changed from 42 to 99"
      }
    });
  });

  it("rejects a foreign package on a later generated Element poll", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent)
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.after
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.after
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.after
      })
      .mockResolvedValueOnce({
        packageName: "com.foreign.app",
        activity: checkpoint.after
      })
      .mockResolvedValue({
        packageName: "com.example.app",
        activity: checkpoint.after
      });
    const cli = androidCli();
    vi.mocked(cli.layout)
      .mockResolvedValueOnce([{
        id: "search",
        resourceId: "search",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }])
      .mockResolvedValue([]);
    const { runner } = fixture({
      adb,
      androidCli: cli,
      generatedReplayPolicy: true
    });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "element",
        locator: { resourceId: "expected" },
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ELEMENT_FAILED",
        message: "Generated Expect foreground changed to com.foreign.app/com.example.app.SearchActivity"
      }
    });
  });

  it("rejects PID replacement inside a generated Element Layout sandwich", async () => {
    const adb = adbPort();
    vi.mocked(adb.foregroundComponent)
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: checkpoint.before
      })
      .mockResolvedValue({
        packageName: "com.example.app",
        activity: checkpoint.after
      });
    vi.mocked(adb.appProcesses)
      .mockResolvedValueOnce([{pid: 42, name: "com.example.app"}])
      .mockResolvedValueOnce([{pid: 42, name: "com.example.app"}])
      .mockResolvedValueOnce([{pid: 42, name: "com.example.app"}])
      .mockResolvedValueOnce([{pid: 99, name: "com.example.app"}]);
    const cli = androidCli();
    vi.mocked(cli.layout)
      .mockResolvedValueOnce([{
        id: "search",
        resourceId: "search",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        children: []
      }])
      .mockResolvedValue([]);
    const { runner } = fixture({
      adb,
      androidCli: cli,
      generatedReplayPolicy: true
    });

    await expect(runner.run({
      ...clickStep(),
      expect: {
        type: "element",
        locator: { resourceId: "expected" },
        timeoutMs: 200
      }
    }, 0)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "EXPECT_ELEMENT_FAILED",
        message: "Generated Expect process changed from 42 to 99"
      }
    });
  });

  it("blocks generated scroll when live container capability drifts", async () => {
    const adb = mainActivityAdb();
    vi.mocked(adb.foregroundComponent).mockResolvedValue({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    });
    const cli = scrollCli("absent");
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "message_list",
      resourceId: "message_list",
      scrollable: false,
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 400 },
      children: []
    }]);
    const { runner } = fixture({
      adb,
      androidCli: cli,
      generatedReplayPolicy: true
    });

    await expect(runner.run(scrollStep, 0)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "ACTION_FAILED" }
    });
    expect(adb.swipe).not.toHaveBeenCalled();
  });

  function bridgeStep(
    overrides: Partial<Extract<JourneyStep, { action: "bridge" }>> = {}
  ): Extract<JourneyStep, { action: "bridge" }> {
    return {
      action: "bridge",
      scenario: "photoCapture",
      description: "Open camera to take a photo",
      triggerLocator: { resourceId: "camera-button" },
      returnTimeoutMs: 10000,
      activity: { before: checkpoint.before, after: checkpoint.after },
      replayMode: "manual",
      ...overrides
    };
  }

  function bridgeCli(): AndroidCliPort {
    const cli = androidCli();
    cli.layout = vi.fn(() => Promise.resolve([{
      id: "camera-button",
      resourceId: "camera-button",
      enabled: true,
      clickable: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: []
    }]));
    return cli;
  }

  function bridgeAdb(
    foregroundSequence: Array<{ packageName: string; activity: string }>
  ): AdbPort {
    const adb = adbPort();
    let index = 0;
    adb.foregroundComponent = vi.fn((() => {
      const result = foregroundSequence[index]
        ?? foregroundSequence[foregroundSequence.length - 1];
      index += 1;
      return Promise.resolve(result);
    }) as never);
    return adb;
  }

  it("replays a bridge step by clicking the trigger and polling for return", async () => {
    const test = fixture({
      adb: bridgeAdb([
        { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
        { packageName: "com.example.app", activity: checkpoint.after }
      ]),
      androidCli: bridgeCli()
    });

    const result = await test.runner.run(bridgeStep(), 0);

    expect(result).toMatchObject({
      status: "passed",
      report: {
        index: 0,
        action: "bridge",
        status: "passed",
        replayMode: "manual",
        locator: {
          status: "found",
          matchedBy: "resourceId",
          fallbackUsed: false
        },
        activity: {
          before: { status: "passed", actual: checkpoint.before },
          after: { status: "passed", actual: checkpoint.after }
        }
      }
    });
    expect(vi.mocked(test.adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("fails with BRIDGE_NO_ESCAPE when trigger does not cause an escape during replay", async () => {
    const test = fixture({
      adb: bridgeAdb([
        { packageName: "com.example.app", activity: checkpoint.before }
      ]),
      androidCli: bridgeCli()
    });

    const result = await test.runner.run(bridgeStep(), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "BRIDGE_NO_ESCAPE", phase: "replay" }
    });
    expect(vi.mocked(test.adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("fails with BRIDGE_NOT_RETURNED when foreground does not return within timeout", async () => {
    const test = fixture({
      adb: bridgeAdb([
        { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" }
      ]),
      androidCli: bridgeCli()
    });

    const result = await test.runner.run(
      bridgeStep({ returnTimeoutMs: 10 }),
      0
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "BRIDGE_NOT_RETURNED", phase: "replay" }
    });
    expect(vi.mocked(test.adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("fails when trigger locator does not resolve in the layout", async () => {
    const test = fixture({
      androidCli: bridgeCli()
    });

    const result = await test.runner.run(
      bridgeStep({ triggerLocator: { resourceId: "nonexistent" } }),
      0
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "LOCATOR_NOT_FOUND" }
    });
    expect(vi.mocked(test.adb.tap)).not.toHaveBeenCalled();
  });

  it("fails when trigger target is not clickable", async () => {
    const cli = bridgeCli();
    cli.layout = vi.fn(() => Promise.resolve([{
      id: "camera-button",
      resourceId: "camera-button",
      enabled: true,
      clickable: false,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      children: []
    }]));
    const test = fixture({ androidCli: cli });

    const result = await test.runner.run(bridgeStep(), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "ACTION_FAILED" }
    });
    expect(vi.mocked(test.adb.tap)).not.toHaveBeenCalled();
  });

  it("returns manualRequired without device ops when manualReplay is false", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.example.app", activity: checkpoint.after }
    ]);
    const test = fixture({
      adb,
      androidCli: bridgeCli(),
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep(), 0);

    expect(result).toMatchObject({
      status: "manualRequired",
      report: {
        index: 0,
        action: "bridge",
        status: "manualRequired",
        replayMode: "manual",
        locator: { status: "notRun", fallbackUsed: false }
      }
    });
    expect(vi.mocked(adb.tap)).not.toHaveBeenCalled();
    expect(vi.mocked(adb.foregroundComponent)).not.toHaveBeenCalled();
  });

  it("replays a manual bridge step normally when manualReplay is true", async () => {
    const test = fixture({
      adb: bridgeAdb([
        { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
        { packageName: "com.example.app", activity: checkpoint.after }
      ]),
      androidCli: bridgeCli(),
      manualReplay: true
    });

    const result = await test.runner.run(bridgeStep(), 0);

    expect(result).toMatchObject({ status: "passed" });
    expect(vi.mocked(test.adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("replays external steps in auto mode even when manualReplay is false", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.example.app", activity: checkpoint.after }
    ]);
    const cli = bridgeCli();
    cli.layout = vi.fn()
      .mockResolvedValueOnce([{
        id: "camera-button",
        resourceId: "camera-button",
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }])
      .mockResolvedValueOnce([{
        id: "shutter",
        resourceId: "shutter",
        enabled: true,
        clickable: true,
        bounds: { left: 50, top: 50, right: 150, bottom: 150 },
        children: []
      }]);
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({ status: "passed" });
    expect(vi.mocked(adb.tap)).toHaveBeenCalledTimes(2);
  });

  it("replays external back steps in auto mode", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.example.app", activity: checkpoint.after }
    ]);
    const cli = bridgeCli();
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      externalSteps: [{
        action: "back",
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({ status: "passed" });
    expect(vi.mocked(adb.tap)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adb.back)).toHaveBeenCalledTimes(1);
  });

  it("fails with EXTERNAL_PACKAGE_MISMATCH when external app changes during step", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.other.app", activity: "com.other.app.OtherActivity" }
    ]);
    const cli = bridgeCli();
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "EXTERNAL_PACKAGE_MISMATCH", phase: "replay" }
    });
    expect(vi.mocked(adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("fails with EXTERNAL_ACTIVITY_MISMATCH when external activity differs", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.android.camera", activity: "com.android.camera.OtherActivity" }
    ]);
    const cli = bridgeCli();
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "EXTERNAL_ACTIVITY_MISMATCH", phase: "replay" }
    });
    expect(vi.mocked(adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("fails with LOCATOR_NOT_FOUND when external step locator does not resolve", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.example.app", activity: checkpoint.after }
    ]);
    const cli = bridgeCli();
    cli.layout = vi.fn()
      .mockResolvedValueOnce([{
        id: "camera-button",
        resourceId: "camera-button",
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }])
      .mockResolvedValueOnce([{
        id: "other",
        resourceId: "other-element",
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
        children: []
      }]);
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "LOCATOR_NOT_FOUND", phase: "replay" }
    });
    expect(vi.mocked(adb.tap)).toHaveBeenCalledTimes(1);
  });

  it("uses escapeTimeoutMs from the step during replay", async () => {
    const adb = bridgeAdb([
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.android.camera", activity: "com.android.camera.CameraActivity" },
      { packageName: "com.example.app", activity: checkpoint.after }
    ]);
    const cli = bridgeCli();
    cli.layout = vi.fn()
      .mockResolvedValueOnce([{
        id: "camera-button",
        resourceId: "camera-button",
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }])
      .mockResolvedValueOnce([{
        id: "shutter",
        resourceId: "shutter",
        enabled: true,
        clickable: true,
        bounds: { left: 50, top: 50, right: 150, bottom: 150 },
        children: []
      }]);
    const test = fixture({
      adb,
      androidCli: cli,
      manualReplay: false
    });

    const result = await test.runner.run(bridgeStep({
      replayMode: "auto",
      escapedPackageName: "com.android.camera",
      escapeTimeoutMs: 8000,
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter" },
        expectedActivity: "com.android.camera.CameraActivity"
      }]
    }), 0);

    expect(result).toMatchObject({ status: "passed" });
  });
});
