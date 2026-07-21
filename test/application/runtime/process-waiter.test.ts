import { describe, expect, it, vi } from "vitest";

import { ProcessWaiter } from "../../../src/application/runtime/process-waiter.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { runtimeFixture } from "../../fakes/runtime-fixture.js";

const options = {
  packageName: "com.example.app",
  deviceSerial: "emulator-5554",
  pollIntervalMs: 100,
  timeoutMs: 250
};

describe("ProcessWaiter", () => {
  it("waits for a delayed App process within the timeout budget", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(42);

    await expect(new ProcessWaiter(runtime.adb, clock).wait(options))
      .resolves.toEqual({
        status: "ready",
        pid: 42,
        durationMs: 100
      });
    expect(clock.sleeps).toEqual([100]);
    expect(runtime.adb.pid).toHaveBeenNthCalledWith(1, {
      packageName: options.packageName,
      deviceSerial: options.deviceSerial,
      timeoutMs: 250
    });
    expect(runtime.adb.pid).toHaveBeenNthCalledWith(2, {
      packageName: options.packageName,
      deviceSerial: options.deviceSerial,
      timeoutMs: 150
    });
  });

  it("times out without polling beyond the deadline", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid).mockResolvedValue(null);

    await expect(new ProcessWaiter(runtime.adb, clock).wait(options))
      .resolves.toEqual({
        status: "timeout",
        durationMs: 250
      });
    expect(clock.sleeps).toEqual([100, 100, 50]);
    expect(runtime.adb.pid).toHaveBeenCalledTimes(3);
    expect(runtime.adb.pid).toHaveBeenLastCalledWith({
      packageName: options.packageName,
      deviceSerial: options.deviceSerial,
      timeoutMs: 50
    });
  });

  it("honors cancellation while sleeping", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    const controller = new AbortController();
    vi.mocked(runtime.adb.pid).mockResolvedValue(null);
    clock.onSleep = (): void => {
      controller.abort();
    };

    await expect(new ProcessWaiter(runtime.adb, clock).wait({
      ...options,
      signal: controller.signal
    })).resolves.toEqual({
      status: "cancelled",
      durationMs: 0
    });
    expect(runtime.adb.pid).toHaveBeenCalledTimes(1);
  });
});
