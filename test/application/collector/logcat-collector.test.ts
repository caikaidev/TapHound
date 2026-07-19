import { describe, expect, it, vi } from "vitest";

import { LogcatCollector } from "../../../src/application/collector/logcat-collector.js";
import type { AdbPort, LogcatOptions } from "../../../src/ports/adb.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { runningCommand } from "../../fakes/process-runner.js";

function adbPort(): AdbPort {
  const running = runningCommand();
  return {
    devices: vi.fn(),
    currentActivity: vi.fn(),
    pid: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(() => running)
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
  it("starts one PID-scoped stream and parses threadtime lines", () => {
    const adb = adbPort();
    const clock = new FakeClock();
    clock.currentTime = 125;
    const collector = new LogcatCollector(adb, clock);

    collector.start({
      deviceSerial: "emulator-5554",
      pid: 1234
    });
    captureOptions(adb).onStdoutLine(
      "07-19 15:00:00.123  1234  1235 D SearchViewModel: query=hello world"
    );

    expect(collector.metadata()).toEqual({
      deviceSerial: "emulator-5554",
      pid: 1234
    });
    expect(collector.lines()).toEqual([{
      receivedAt: 125,
      raw: "07-19 15:00:00.123  1234  1235 D SearchViewModel: query=hello world",
      pid: 1234,
      tid: 1235,
      level: "D",
      tag: "SearchViewModel",
      message: "query=hello world"
    }]);
  });

  it("preserves an unparsed line as raw evidence", () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    collector.start({ deviceSerial: "device", pid: 42 });

    captureOptions(adb).onStdoutLine("--------- beginning of main");

    expect(collector.lines()).toEqual([{
      receivedAt: 0,
      raw: "--------- beginning of main"
    }]);
  });

  it("slices lines using an inclusive monotonic time window", () => {
    const adb = adbPort();
    const clock = new FakeClock();
    const collector = new LogcatCollector(adb, clock);
    collector.start({ deviceSerial: "device", pid: 42 });
    const options = captureOptions(adb);

    clock.currentTime = 9;
    options.onStdoutLine("before");
    clock.currentTime = 10;
    options.onStdoutLine("start");
    clock.currentTime = 20;
    options.onStdoutLine("end");
    clock.currentTime = 21;
    options.onStdoutLine("after");

    expect(collector.linesBetween(10, 20).map((line) => line.raw))
      .toEqual(["start", "end"]);
  });

  it("starts before launch and scopes buffered and future lines to the App PID", () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    collector.start({ deviceSerial: "device" });
    const options = captureOptions(adb);
    options.onStdoutLine(
      "07-19 15:00:00.100  41  41 D Other: ignore"
    );
    options.onStdoutLine(
      "07-19 15:00:00.101  42  42 D App: startup"
    );

    collector.scopeToPid(42);
    options.onStdoutLine(
      "07-19 15:00:00.102  41  41 D Other: ignore later"
    );
    options.onStdoutLine(
      "07-19 15:00:00.103  42  42 D App: ready"
    );

    expect(collector.metadata()).toEqual({
      deviceSerial: "device",
      pid: 42
    });
    expect(collector.lines().map((line) => line.message))
      .toEqual(["startup", "ready"]);
  });

  it("stops the underlying stream idempotently", () => {
    const adb = adbPort();
    const collector = new LogcatCollector(adb, new FakeClock());
    collector.start({ deviceSerial: "device", pid: 42 });

    const first = collector.stop();
    const second = collector.stop();

    expect(first).toBe(second);
  });

  it("does not allow two streams", () => {
    const collector = new LogcatCollector(adbPort(), new FakeClock());
    collector.start({ deviceSerial: "device", pid: 42 });

    expect((): void => {
      collector.start({ deviceSerial: "device", pid: 42 });
    })
      .toThrow(/already started/i);
  });
});
