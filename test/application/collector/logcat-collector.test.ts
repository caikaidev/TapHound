import { describe, expect, it, vi } from "vitest";

import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import type { AdbPort, LogcatOptions } from "../../../src/ports/adb.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { runningCommand } from "../../fakes/process-runner.js";

function adbPort(): AdbPort {
  const running = runningCommand();
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
    startLogcat: vi.fn(() => running),
    dumpLogcat: vi.fn()
  };
}

function captureOptions(adb: AdbPort): LogcatOptions {
  const call = vi.mocked(adb.startLogcat).mock.calls[0]?.[0];
  if (call === undefined) {
    throw new Error("Logcat was not started");
  }
  return call;
}

describe("LogcatCollector", () => {
  it("rejects a stream that exits during asynchronous startup", async () => {
    const adb = adbPort();
    const failed = Promise.resolve({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "logcat unavailable",
      durationMs: 1,
      timedOut: false,
      cancelled: false
    });
    vi.mocked(adb.startLogcat).mockReturnValue({
      started: failed,
      completion: failed,
      stop: () => failed
    });
    const collector = new LogcatCollector(adb, new FakeClock());

    await expect(collector.start({ deviceSerial: "device" }))
      .rejects.toThrow("logcat unavailable");
  });

  it("starts one PID-scoped stream and parses threadtime lines", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    clock.currentTime = 125;
    const collector = new LogcatCollector(adb, clock);

    await collector.start({
      deviceSerial: "emulator-5554"
    });
    collector.scopeToPids([1234]);
    captureOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  1234  1235 D SearchViewModel: query=hello world"
    );

    expect(collector.metadata()).toEqual({
      deviceSerial: "emulator-5554",
      pids: [1234]
    });
    expect(collector.lines()).toEqual([{
      receivedAt: 125,
      deviceTimestamp: "07-19 15:00:00.123",
      raw: "07-19 15:00:00.123  1234  1235 D SearchViewModel: query=hello world",
      pid: 1234,
      tid: 1235,
      level: "D",
      tag: "SearchViewModel",
      message: "query=hello world"
    }]);
  });

  it("applies known PIDs before startup output can enter the buffer", async () => {
    const adb = adbPort();
    vi.mocked(adb.startLogcat).mockImplementation((options) => {
      options.onStdoutLine(
        "07-19 15:00:00.100  41  41 D Other: startup noise"
      );
      options.onStdoutLine(
        "07-19 15:00:00.101  42  42 D App: startup evidence"
      );
      return runningCommand();
    });
    const collector = new LogcatCollector(adb, new FakeClock());

    await collector.start({ deviceSerial: "device", pids: [42] });

    expect(collector.lines().map((line) => line.message))
      .toEqual(["startup evidence"]);
    expect(collector.rawLines().map((line) => line.message))
      .toEqual(["startup evidence"]);
  });

  it("preserves an unparsed line as raw evidence", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    await collector.start({ deviceSerial: "device" });

    captureOptions(adb).onStdoutLine("--------- beginning of main");

    expect(collector.rawLines()).toEqual([{
      receivedAt: 0,
      raw: "--------- beginning of main"
    }]);
    expect(collector.lines()).toEqual([]);
  });

  it("slices lines using an inclusive monotonic time window", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    await collector.start({ deviceSerial: "device" });
    const options = captureOptions(adb);

    clock.currentTime = 9;
    options.onStdoutLine("07-19 15:00:00.001  42  42 D App: before");
    clock.currentTime = 10;
    options.onStdoutLine("07-19 15:00:00.002  42  42 D App: start");
    clock.currentTime = 20;
    options.onStdoutLine("07-19 15:00:00.003  42  42 D App: end");
    clock.currentTime = 21;
    options.onStdoutLine("07-19 15:00:00.004  42  42 D App: after");
    collector.scopeToPids([42]);

    expect(collector.linesBetween(10, 20).map((line) => line.raw))
      .toEqual([
        "07-19 15:00:00.002  42  42 D App: start",
        "07-19 15:00:00.003  42  42 D App: end"
      ]);
  });

  it("parses colon-containing tags without confusing message colons", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    await collector.start({ deviceSerial: "device" });
    collector.scopeToPids([42]);
    captureOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  42  42 I Network:Search: result: ready"
    );
    expect(collector.lines()[0]).toMatchObject({
      deviceTimestamp: "07-19 15:00:00.123",
      tag: "Network:Search",
      message: "result: ready"
    });
  });

  it("excludes unparsed lines from matching while keeping raw artifacts", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    await collector.start({ deviceSerial: "device" });
    collector.scopeToPids([42]);
    captureOptions(adb).onStdoutLine("not threadtime App: secret");
    expect(collector.lines()).toEqual([]);
    expect(collector.rawLines()).toHaveLength(1);
  });

  it("bounds retained lines and bytes and declares dropped evidence", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock, {
      maxLines: 2, maxBytes: 100
    });
    await collector.start({ deviceSerial: "device" });
    const options = captureOptions(adb);
    clock.currentTime = 1;
    options.onStdoutLine("07-19 15:00:00.001  42  42 D App: first");
    clock.currentTime = 2;
    options.onStdoutLine("07-19 15:00:00.002  42  42 D App: second");
    clock.currentTime = 3;
    options.onStdoutLine("07-19 15:00:00.003  42  42 D App: third");
    collector.scopeToPids([42]);
    expect(collector.lines()).toHaveLength(2);
    expect(collector.completeSince(1)).toBe(false);
    expect(collector.completeSince(2)).toBe(true);
    expect(collector.metadata()).toMatchObject({
      droppedLines: 1,
      droppedBytes: expect.any(Number) as number
    });
  });

  it("does not treat another PID's dropped lines as scoped evidence loss", async () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock, {
      maxLines: 2, maxBytes: 200
    });
    await collector.start({ deviceSerial: "device" });
    const options = captureOptions(adb);
    clock.currentTime = 1;
    options.onStdoutLine("07-19 15:00:00.001  41  41 D Other: first");
    clock.currentTime = 2;
    options.onStdoutLine("07-19 15:00:00.002  41  41 D Other: second");
    clock.currentTime = 3;
    options.onStdoutLine("07-19 15:00:00.003  41  41 D Other: third");

    collector.scopeToPids([42]);

    expect(collector.completeSince(0)).toBe(true);
    expect(collector.metadata()).toEqual({
      deviceSerial: "device",
      pids: [42]
    });
  });

  it("starts before launch and scopes buffered and future lines to the App PID", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    await collector.start({ deviceSerial: "device" });
    const options = captureOptions(adb);
    options.onStdoutLine(
      "07-19 15:00:00.100  41  41 D Other: ignore"
    );
    options.onStdoutLine(
      "07-19 15:00:00.101  42  42 D App: startup"
    );

    expect(collector.lines()).toEqual([]);
    collector.scopeToPids([42]);
    options.onStdoutLine(
      "07-19 15:00:00.102  41  41 D Other: ignore later"
    );
    options.onStdoutLine(
      "07-19 15:00:00.103  42  42 D App: ready"
    );

    expect(collector.metadata()).toEqual({
      deviceSerial: "device",
      pids: [42]
    });
    expect(collector.lines().map((line) => line.message))
      .toEqual(["startup", "ready"]);
    expect(collector.rawLines().map((line) => line.message))
      .toEqual(["startup", "ready"]);
  });

  it("stops the underlying stream idempotently", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    await collector.start({ deviceSerial: "device" });

    const first = collector.stop();
    const second = collector.stop();

    expect(first).toBe(second);
  });

  it("does not allow two streams", async () => {
    const collector = new LogcatCollector(adbPort(), new FakeClock());
    await collector.start({ deviceSerial: "device" });

    await expect(collector.start({ deviceSerial: "device" }))
      .rejects.toThrow(/already started/i);
  });

  it("retains the newest lines in order after sustained buffer overflow", async () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock(), {
      maxLines: 100,
      maxBytes: 1024 * 1024
    });
    await collector.start({ deviceSerial: "device", pids: [42] });
    const options = captureOptions(adb);

    for (let index = 0; index < 5000; index += 1) {
      options.onStdoutLine(
        `07-19 15:00:00.001  42  42 D App: line ${String(index)}`
      );
    }

    const retained = collector.lines().map((line) => line.message);
    expect(retained).toHaveLength(100);
    expect(retained[0]).toBe("line 4900");
    expect(retained.at(-1)).toBe("line 4999");
    expect(collector.rawLines()).toHaveLength(100);
    expect(collector.metadata()).toMatchObject({ droppedLines: 4900 });
  });
});
