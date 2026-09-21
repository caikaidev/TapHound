import { describe, expect, it, vi } from "vitest";

import { ExpectationEvaluator } from "../../../src/application/assertion/expectation-evaluator.js";
import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import type { LayoutElement } from "../../../src/domain/layout.js";
import type { AdbPort, LogcatOptions } from "../../../src/ports/adb.js";
import type { UiSnapshotProvider } from "../../../src/ports/ui-snapshot.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import {
  runningCommand
} from "../../fakes/process-runner.js";
import { uiSnapshotProviderFromLayout } from "../../fakes/ui-snapshot.js";

function adbPort(): AdbPort {
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
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(() => runningCommand()),
    dumpLogcat: vi.fn()
  };
}

function androidCli(): UiSnapshotProvider & {
  layout: (options: {
    deviceSerial: string;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  }) => Promise<readonly LayoutElement[]>;
} {
  const layout = vi.fn<(
    options: {
      deviceSerial: string;
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
    }
  ) => Promise<readonly LayoutElement[]>>();
  const provider = uiSnapshotProviderFromLayout(layout);
  return {
    layout,
    descriptor: provider.descriptor,
    capture: provider.capture,
    close: provider.close
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
  it("binds app-emitted errorClass to one hashed event without copying other fields", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
    logcatOptions(adb).onStdoutLine(
      '07-19 15:00:00.123 1234 1235 E App: {"event":"failed","fields":{"errorClass":"network","request":"private-value"}}'
    );
    const evaluator = new ExpectationEvaluator(adb, androidCli(), collector, clock);
    const result = await evaluator.evaluate({
      type: "logcatEvent", tag: "App", event: "failed",
      fields: {}, unique: true, window: { from: "stepStart" }, timeoutMs: 100
    }, context);
    expect(result).toMatchObject({
      status: "passed", logcatEvent: { requestErrorClass: "network", matchedCount: 1 }
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("matches exactly one structured event across a declared marker window without publishing its raw value", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
    clock.currentTime = 10;
    logcatOptions(adb).onStdoutLine(
      '07-19 15:00:00.123  1234  1235 I Search:Trace: {"event":"submitted","fields":{"request":"private-value","success":true}}'
    );
    const evaluator = new ExpectationEvaluator(adb, androidCli(), collector, clock);
    const result = await evaluator.evaluate({
      type: "logcatEvent",
      tag: "Search:Trace",
      event: "submitted",
      fields: { success: true },
      correlation: { key: "request", value: "private-value" },
      unique: true,
      window: { from: "marker", markerId: "search-start" },
      timeoutMs: 100
    }, {
      ...context,
      stepStartedAt: 50,
      markers: new Map([["search-start", 5]])
    });
    expect(result).toMatchObject({
      status: "passed",
      type: "logcatEvent",
      durationMs: 100,
      logcatEvent: {
        matchedCount: 1,
        window: { from: "marker", markerId: "search-start" },
        startedAtMs: 5,
        matchedLineSha256: expect.stringMatching(/^[a-f\d]{64}$/) as string
      }
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("fails closed on duplicate structured events and on a correlation mismatch", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
    const line = '07-19 15:00:00.123  1234  1235 I App: {"event":"ready","fields":{"id":"abc"}}';
    logcatOptions(adb).onStdoutLine(line);
    logcatOptions(adb).onStdoutLine(line);
    const evaluator = new ExpectationEvaluator(adb, androidCli(), collector, clock);
    const expectEvent = {
      type: "logcatEvent" as const,
      tag: "App",
      event: "ready",
      fields: {},
      unique: true as const,
      window: { from: "stepStart" as const },
      timeoutMs: 100
    };
    expect(await evaluator.evaluate(expectEvent, context)).toMatchObject({
      status: "failed",
      code: "EXPECT_LOGCAT_AMBIGUOUS",
      logcatEvent: { matchedCount: 2 }
    });
    expect(await evaluator.evaluate({
      ...expectEvent,
      correlation: { key: "id", value: "different" }
    }, context)).toMatchObject({
      status: "failed",
      code: "EXPECT_LOGCAT_FAILED",
      message: "Logcat event did not appear before timeout",
      logcatEvent: { matchedCount: 0 }
    });
  });

  it("fails immediately when an injected Activity observation guard rejects", async () => {
    const adb = adbPort();
    vi.mocked(adb.currentActivity).mockResolvedValue(
      "com.example.app.SearchActivity"
    );
    const clock = new FakeClock();
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
    }, context, undefined, {
      activity: () => Promise.resolve({
        status: "failed",
        message: "Foreground package escaped generated replay"
      })
    })).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_ACTIVITY_FAILED",
      message: "Foreground package escaped generated replay",
      durationMs: 0
    });
    expect(adb.currentActivity).not.toHaveBeenCalled();
  });

  it("fails on a guarded later Element poll without accepting raw Layout", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "target",
      resourceId: "target",
      enabled: true,
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      children: []
    }]);
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      cli,
      new LogcatCollector(adb, clock),
      clock,
      100
    );
    const layoutObservation = vi.fn()
      .mockResolvedValueOnce({
        status: "observed",
        layout: []
      })
      .mockResolvedValueOnce({
        status: "failed",
        message: "Generated replay PID changed during Layout"
      });
    await expect(evaluator.evaluate({
      type: "element",
      locator: { resourceId: "target" },
      timeoutMs: 200
    }, context, undefined, {
      layout: layoutObservation
    })).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_ELEMENT_FAILED",
      message: "Generated replay PID changed during Layout",
      durationMs: 100
    });
    expect(layoutObservation).toHaveBeenCalledTimes(2);
    expect(layoutObservation).toHaveBeenNthCalledWith(1, { timeoutMs: 200 });
    expect(layoutObservation).toHaveBeenNthCalledWith(2, { timeoutMs: 100 });
    expect(cli.layout).not.toHaveBeenCalled();
  });

  it("does not pass when a guarded observation aborts during its command", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      androidCli(),
      new LogcatCollector(adb, clock),
      clock
    );
    const controller = new AbortController();

    await expect(evaluator.evaluate({
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 200
    }, context, controller.signal, {
      activity: () => {
        controller.abort();
        return Promise.resolve({
          status: "observed",
          activity: "com.example.app.SearchActivity"
        });
      }
    })).resolves.toMatchObject({
      status: "cancelled",
      type: "activity",
      durationMs: 0
    });
  });

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

  it("passes an enabled predicate when the resolved element matches", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "btn_next",
      resourceId: "btn_next",
      enabled: true,
      clickable: true,
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
      locator: { resourceId: "btn_next" },
      enabled: true,
      clickable: true,
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "passed",
      type: "element"
    });
  });

  it("passes a disabled predicate when the resolved element is disabled", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "btn_next",
      resourceId: "btn_next",
      enabled: false,
      clickable: false,
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
      locator: { resourceId: "btn_next" },
      enabled: false,
      clickable: false,
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "passed",
      type: "element"
    });
  });

  it("fails an enabled predicate at timeout when the element stays disabled", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "btn_next",
      resourceId: "btn_next",
      enabled: false,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    }]);
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      cli,
      new LogcatCollector(adb, clock),
      clock,
      100
    );

    const result = await evaluator.evaluate({
      type: "element",
      locator: { resourceId: "btn_next" },
      enabled: true,
      timeoutMs: 100
    }, context);
    expect(result).toMatchObject({
      status: "failed",
      code: "EXPECT_ELEMENT_FAILED"
    });
    expect(result.status === "failed" ? result.message : undefined)
      .toContain("expected enabled=true");
  });

  it("passes an absent expectation when the locator has no matches", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "search_input",
      resourceId: "search_input",
      enabled: true,
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
      locator: { resourceId: "btn_next" },
      absent: true,
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "passed",
      type: "element"
    });
  });

  it("fails an absent expectation at timeout when the element remains present", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([{
      id: "btn_next",
      resourceId: "btn_next",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    }]);
    const clock = new FakeClock();
    const evaluator = new ExpectationEvaluator(
      adb,
      cli,
      new LogcatCollector(adb, clock),
      clock,
      100
    );

    const result = await evaluator.evaluate({
      type: "element",
      locator: { resourceId: "btn_next" },
      absent: true,
      timeoutMs: 100
    }, context);
    expect(result).toMatchObject({
      status: "failed",
      code: "EXPECT_ELEMENT_FAILED"
    });
    expect(result.status === "failed" ? result.message : undefined)
      .toContain("expected absent element matched by resourceId");
  });

  it("fails an absent expectation at timeout when the locator stays ambiguous", async () => {
    const adb = adbPort();
    const cli = androidCli();
    vi.mocked(cli.layout).mockResolvedValue([
      {
        id: "first",
        resourceId: "result",
        enabled: true,
        center: { x: 10, y: 10 },
        children: []
      },
      {
        id: "second",
        resourceId: "result",
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

    const result = await evaluator.evaluate({
      type: "element",
      locator: { resourceId: "result" },
      absent: true,
      timeoutMs: 100
    }, context);
    expect(result).toMatchObject({
      status: "failed",
      code: "EXPECT_ELEMENT_FAILED"
    });
    expect(result.status === "failed" ? result.message : undefined)
      .toContain("expected absent element still resolvable");
  });

  it("matches a literal Logcat line by tag, level, and step window", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
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
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
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

  it("accepts retained positive Logcat evidence after the scoped buffer rolls", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock, {
      maxLines: 2, maxBytes: 1_000
    });
    await collector.start({ deviceSerial: context.deviceSerial, pids: [1234] });
    const options = logcatOptions(adb);
    clock.currentTime = 1;
    options.onStdoutLine(
      "07-19 15:00:00.121  1234  1235 D SearchViewModel: old noise"
    );
    clock.currentTime = 2;
    options.onStdoutLine(
      "07-19 15:00:00.122  1234  1235 D SearchViewModel: query=hello world"
    );
    clock.currentTime = 3;
    options.onStdoutLine(
      "07-19 15:00:00.123  1234  1235 D SearchViewModel: new noise"
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
      pattern: "query=hello world",
      match: "literal",
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "passed",
      matchedLine: expect.stringContaining("query=hello world") as string
    });
    expect(collector.completeSince(context.stepStartedAt)).toBe(false);
  });

  it("reports scoped buffer-loss diagnostics when no Logcat match remains", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock, {
      maxLines: 1, maxBytes: 1_000
    });
    await collector.start({ deviceSerial: context.deviceSerial, pids: [1234] });
    const options = logcatOptions(adb);
    clock.currentTime = 1;
    options.onStdoutLine(
      "07-19 15:00:00.121  1234  1235 D SearchViewModel: old noise"
    );
    clock.currentTime = 2;
    options.onStdoutLine(
      "07-19 15:00:00.122  1234  1235 D SearchViewModel: new noise"
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
      pattern: "missing",
      match: "literal",
      timeoutMs: 200
    }, context)).resolves.toMatchObject({
      status: "failed",
      code: "EXPECT_LOGCAT_FAILED",
      message: expect.stringMatching(
        /droppedLines=1, droppedBytes=\d+, lastDroppedAtMs=1/
      ) as string
    });
  });

  it("does not match Logcat received before the step window", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: context.deviceSerial });
    collector.scopeToPids([1234]);
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
