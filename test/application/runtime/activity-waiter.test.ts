import { describe, expect, it, vi } from "vitest";

import { ActivityWaiter } from "../../../src/application/runtime/activity-waiter.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { runtimeFixture } from "../../fakes/runtime-fixture.js";

const options = {
  packageName: "com.example.app",
  deviceSerial: "emulator-5554",
  expectedActivity: "com.example.app.HomeActivity",
  pollIntervalMs: 100,
  timeoutMs: 300
};

describe("ActivityWaiter", () => {
  it("waits through a transient Activity", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid).mockResolvedValue(42);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.SplashActivity")
      .mockResolvedValueOnce("com.example.app.HomeActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait(options))
      .resolves.toEqual({
        status: "ready",
        actual: "com.example.app.HomeActivity",
        durationMs: 100
      });
    expect(clock.sleeps).toEqual([100]);
  });

  it("returns the last Activity on timeout", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid).mockResolvedValue(42);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait({
      ...options,
      timeoutMs: 200
    })).resolves.toEqual({
      status: "timeout",
      actual: "com.example.app.SplashActivity",
      durationMs: 200
    });
  });

  it("stops when the configured App process exits", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    vi.mocked(runtime.adb.pid)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(null);
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    await expect(new ActivityWaiter(runtime.adb, clock).wait(options))
      .resolves.toMatchObject({
        status: "processMissing",
        actual: "com.example.app.SplashActivity"
      });
  });

  it("honors an already aborted signal", async () => {
    const runtime = runtimeFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(new ActivityWaiter(runtime.adb, new FakeClock()).wait({
      ...options,
      signal: controller.signal
    })).resolves.toEqual({
      status: "cancelled",
      durationMs: 0
    });
    expect(runtime.adb.pid).not.toHaveBeenCalled();
  });
});
