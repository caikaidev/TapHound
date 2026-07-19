import { describe, expect, it, vi } from "vitest";

import { ExpectationEvaluator } from "../../../src/application/assertion/expectation-evaluator.js";
import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import type { AdbPort, LogcatOptions } from "../../../src/ports/adb.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import {
  commandResult,
  runningCommand
} from "../../fakes/process-runner.js";

function adbPort(): AdbPort {
  return {
    devices: vi.fn(),
    currentActivity: vi.fn(),
    pid: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(() => runningCommand())
  };
}

function androidCli(): AndroidCliPort {
  return {
    describeProject: vi.fn(),
    runApp: vi.fn(() => Promise.resolve(commandResult())),
    layout: vi.fn(),
    layoutDiff: vi.fn(),
    captureScreen: vi.fn(),
    resolveScreen: vi.fn()
  };
}

const context = {
  packageName: "com.example.app",
  deviceSerial: "emulator-5554",
  stepStartedAt: 0
};

function logcatOptions(adb: AdbPort): LogcatOptions {
  const options = vi.mocked(adb.startLogcat).mock.calls[0]?.[0];
  if (options === undefined) {
    throw new Error("Logcat was not started");
  }
  return options;
}

describe("ExpectationEvaluator", () => {
  it("polls until the expected Activity is resumed", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValueOnce("com.example.app.SearchActivity");
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      new LogcatCollector(adb, clock),
      clock,
      100
    );

    await expect(evaluator.evaluate({
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 300
    }, context)).resolves.toMatchObject({
      status: "passed",
      type: "activity",
      durationMs: 100
    });
    expect(vi.mocked(adb.currentActivity).mock.calls.map(([identity]) => (
      identity.timeoutMs
    ))).toEqual([300, 200]);
  });

  it("returns the Activity failure code at timeout", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity)
      .mockResolvedValue("com.example.app.MainActivity");
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      new LogcatCollector(adb, clock),
      clock,
      100
    );

    await expect(evaluator.evaluate({
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_ACTIVITY_FAILED",
      actual: "com.example.app.MainActivity",
      durationMs: 200
    });
  });

  it("maps a hung Activity command deadline to the Expect failure", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    vi.mocked(adb.currentActivity).mockImplementation(() => {
      clock.currentTime = 200;
      return Promise.reject(new Error("ADB command timed out"));
    });
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      new LogcatCollector(adb, clock),
      clock
    );

    await expect(evaluator.evaluate({
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_ACTIVITY_FAILED",
      durationMs: 200
    });
  });

  it("passes when an expected disabled Element appears", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "search_input",
      resourceId: "search_input",
      enabled: false,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    }]);
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      cli,
      new LogcatCollector(adb, clock),
      clock
    );

    await expect(evaluator.evaluate({
      type: "element",
      locator: { resourceId: "search_input" },
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "passed",
      type: "element"
    });
  });

  it("does not pass an Element Expect when its Locator is ambiguous", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([
      {
        id: "first",
        resourceId: "result",
        text: "First",
        enabled: true,
        center: { x: 10, y: 10 },
        children: []
      },
      {
        id: "second",
        resourceId: "result",
        text: "Second",
        enabled: true,
        center: { x: 20, y: 20 },
        children: []
      }
    ]);
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      cli,
      new LogcatCollector(adb, clock),
      clock,
      100
    );

    await expect(evaluator.evaluate({
      type: "element",
      locator: { resourceId: "result" },
      timeoutMs: 100
    }, context)).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_ELEMENT_FAILED"
    });
  });

  it("matches a literal Logcat line by tag, level, and step window", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    collector.start({ deviceSerial: context.deviceSerial, pid: 1234 });
    clock.currentTime = 10;
    logcatOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  1234  1235 D SearchViewModel: query=hello world"
    );
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      collector,
      clock
    );

    const result = await evaluator.evaluate({
      type: "logcat",
      tag: "SearchViewModel",
      level: "D",
      pattern: "query=hello world",
      match: "literal",
      timeoutMs: 200
    }, context);

    expect(result).toMatchObject({
      status: "passed",
      type: "logcat"
    });
    expect(result.status === "passed" ? result.matchedLine : undefined)
      .toContain("query=hello world");
  });

  it("matches an explicitly configured regular expression", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    collector.start({ deviceSerial: context.deviceSerial, pid: 1234 });
    logcatOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  1234  1235 I SearchViewModel: count=42"
    );
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      collector,
      clock
    );

    await expect(evaluator.evaluate({
      type: "logcat",
      tag: "SearchViewModel",
      pattern: "count=\\d+",
      match: "regex",
      timeoutMs: 200
    }, context)).resolves.toMatchObject({ status: "passed" });
  });

  it("does not match Logcat received before the step window", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    collector.start({ deviceSerial: context.deviceSerial, pid: 1234 });
    logcatOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  1234  1235 D SearchViewModel: stale"
    );
    clock.currentTime = 50;
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      collector,
      clock,
      100
    );

    await expect(evaluator.evaluate({
      type: "logcat",
      tag: "SearchViewModel",
      pattern: "stale",
      match: "literal",
      timeoutMs: 100
    }, { ...context, stepStartedAt: 50 })).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_LOGCAT_FAILED"
    });
  });

  it("returns cancelled when the signal is aborted", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const controller = new AbortController();
    controller.abort();
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      new LogcatCollector(adb, clock),
      clock
    );

    await expect(evaluator.evaluate({
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 200
    }, context, controller.signal)).resolves.toMatchObject({
      status: "cancelled"
    });
  });
});
