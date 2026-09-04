import { describe, expect, it, vi } from "vitest";

import { IdleWaiter } from "../../../src/application/wait/idle-waiter.js";
import type { UiStabilityProbe } from "../../../src/ports/ui-stability.js";
import { FakeClock } from "../../fakes/fake-clock.js";

function stabilityProbe(): UiStabilityProbe {
  return {
    reset: vi.fn(),
    sample: vi.fn()
  };
}

const config = {
  pollIntervalMs: 100,
  stablePolls: 2,
  timeoutMs: 500
};

describe("IdleWaiter", () => {
  it("becomes stable after consecutive empty Layout Diffs", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample)
      .mockResolvedValueOnce([{ id: "changed" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const clock = new FakeClock();

    const result = await new IdleWaiter(
      cli,
      clock,
      "emulator-5554"
    ).waitUntilIdle(config);

    expect(result).toEqual({
      status: "stable",
      polls: 3,
      durationMs: 200,
      strategy: "hybrid",
      fallbackUsed: false,
      frameActivityDetected: false,
      samplingDurationMs: 0
    });
    expect(cli.sample).toHaveBeenCalledTimes(3);
    expect(cli.reset).toHaveBeenCalledOnce();
    expect(vi.mocked(cli.sample).mock.calls.map(([options]) => (
      options.timeoutMs
    ))).toEqual([500, 400, 300]);
    expect(clock.sleeps).toEqual([100, 100]);
  });

  it("resets the stable counter after a new change", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "new-change" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554"
    ).waitUntilIdle(config))
      .resolves.toMatchObject({ status: "stable", polls: 4 });
  });

  it("times out with the last nonempty Diff", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample).mockImplementation(() => Promise.resolve([
      { id: "still-changing" }
    ]));
    const clock = new FakeClock();

    const result = await new IdleWaiter(
      cli,
      clock,
      "emulator-5554"
    ).waitUntilIdle({
      ...config,
      timeoutMs: 250
    });

    expect(result).toEqual({
      status: "timeout",
      code: "IDLE_TIMEOUT",
      polls: 4,
      durationMs: 250,
      lastDiff: [{ id: "still-changing" }],
      strategy: "hybrid",
      fallbackUsed: false,
      frameActivityDetected: false,
      samplingDurationMs: 0
    });
  });

  it("maps a hung Layout command deadline to IDLE_TIMEOUT", async () => {
    const cli = stabilityProbe();
    const clock = new FakeClock();
    vi.mocked(cli.sample).mockImplementation(() => {
      clock.currentTime = 250;
      return Promise.reject(new Error("layout command timed out"));
    });

    await expect(new IdleWaiter(
      cli,
      clock,
      "emulator-5554"
    ).waitUntilIdle({
      ...config,
      timeoutMs: 250
    })).resolves.toEqual({
      status: "timeout",
      code: "IDLE_TIMEOUT",
      polls: 1,
      durationMs: 250,
      lastDiff: [],
      strategy: "hybrid",
      fallbackUsed: false,
      frameActivityDetected: false,
      samplingDurationMs: 0
    });
  });

  it("returns cancelled without polling when already aborted", async () => {
    const cli = stabilityProbe();
    const controller = new AbortController();
    controller.abort();

    await expect(new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554"
    ).waitUntilIdle(
      config,
      controller.signal
    )).resolves.toEqual({
      status: "cancelled",
      polls: 0,
      durationMs: 0
    });
    expect(cli.sample).not.toHaveBeenCalled();
  });

  it("returns cancelled when aborted between polls", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample).mockResolvedValue([]);
    const clock = new FakeClock();
    const controller = new AbortController();
    clock.onSleep = (): void => {
      controller.abort();
    };

    await expect(new IdleWaiter(
      cli,
      clock,
      "emulator-5554"
    ).waitUntilIdle(
      config,
      controller.signal
    )).resolves.toMatchObject({
      status: "cancelled",
      polls: 1,
      durationMs: 0
    });
  });

  it("confirms stability with layout diff for gfxFrameStats backend", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample).mockImplementation((options) => {
      return Promise.resolve(options.stabilityBackend === "uiautomator"
        ? { changes: [], backend: "uiautomator" }
        : { changes: [], backend: "gfxFrameStats" });
    });
    const clock = new FakeClock();

    const result = await new IdleWaiter(
      cli,
      clock,
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 5000
    });

    expect(result).toMatchObject({
      status: "stable",
      backend: "uiautomator",
      polls: 4,
      durationMs: 300,
      strategy: "hybrid",
      fallbackUsed: false
    });
    expect(cli.sample).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(cli.sample).mock.calls;
    expect(calls[2]?.[0]).toMatchObject({
      stabilityBackend: "uiautomator"
    });
  });

  it("continues polling when confirmation shows layout changes", async () => {
    const cli = stabilityProbe();
    let confirmCount = 0;
    vi.mocked(cli.sample).mockImplementation((options) => {
      if (options.stabilityBackend !== "uiautomator") {
        return Promise.resolve({ changes: [], backend: "gfxFrameStats" });
      }
      confirmCount += 1;
      return Promise.resolve({
        changes: confirmCount === 1 ? [{ id: "change" }] : [],
        backend: "uiautomator"
      });
    });
    const clock = new FakeClock();

    const result = await new IdleWaiter(
      cli,
      clock,
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 5000
    });

    expect(result).toMatchObject({
      status: "stable",
      backend: "uiautomator",
      polls: 5,
      durationMs: 400
    });
  });

  it("does not declare frame stability without structural confirmation", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample).mockImplementation((options) => {
      return Promise.resolve(options.stabilityBackend === "uiautomator"
        ? { changes: [{ layoutSha256: "changing" }], backend: "uiautomator" }
        : { changes: [], backend: "gfxFrameStats" });
    });
    const clock = new FakeClock();

    const result = await new IdleWaiter(
      cli,
      clock,
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 200
    });

    expect(result).toMatchObject({
      status: "timeout",
      backend: "uiautomator",
      polls: 3
    });
  });

  it("falls back to structural stability during continuous frame activity", async () => {
    const cli = stabilityProbe();
    let structuralPolls = 0;
    vi.mocked(cli.sample).mockImplementation((options) => {
      if (options.stabilityBackend !== "uiautomator") {
        return Promise.resolve({
          changes: [{ frameStats: String(Date.now()) }],
          backend: "gfxFrameStats"
        });
      }
      structuralPolls += 1;
      return Promise.resolve({
        changes: structuralPolls === 1
          ? [{ layoutSha256: "layout-1" }]
          : [],
        backend: "uiautomator"
      });
    });

    await expect(new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 1000
    })).resolves.toMatchObject({
      status: "stable",
      backend: "uiautomator",
      strategy: "hybrid",
      fallbackUsed: true,
      frameActivityDetected: true,
      polls: 5
    });
  });

  it("uses only structural polling for layoutDiff strategy", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample)
      .mockResolvedValueOnce({
        changes: [{ layoutSha256: "layout-1" }],
        backend: "uiautomator"
      })
      .mockResolvedValue({
        changes: [],
        backend: "uiautomator"
      });

    await expect(new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      strategy: "layoutDiff",
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 1000
    })).resolves.toMatchObject({
      status: "stable",
      backend: "uiautomator",
      strategy: "layoutDiff",
      fallbackUsed: false
    });
    expect(vi.mocked(cli.sample).mock.calls.every(([options]) => (
      options.stabilityBackend === "uiautomator"
    ))).toBe(true);
  });

  it("uses structural strategy to skip frameStats entirely", async () => {
    const cli = stabilityProbe();
    vi.mocked(cli.sample)
      .mockResolvedValueOnce({
        changes: [{ layoutSha256: "layout-1" }],
        backend: "uiautomator"
      })
      .mockResolvedValue({
        changes: [],
        backend: "uiautomator"
      });

    const result = await new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554",
      "com.example.app"
    ).waitUntilIdle({
      strategy: "structural",
      pollIntervalMs: 100,
      stablePolls: 2,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      status: "stable",
      backend: "uiautomator",
      strategy: "structural",
      fallbackUsed: false,
      frameActivityDetected: false
    });
    expect(vi.mocked(cli.sample).mock.calls.every(([options]) => (
      options.stabilityBackend === "uiautomator"
    ))).toBe(true);
  });
});
