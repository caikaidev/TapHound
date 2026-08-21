import { describe, expect, it, vi } from "vitest";

import { IdleWaiter } from "../../../src/application/wait/idle-waiter.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { commandResult } from "../../fakes/process-runner.js";

function androidCli(): AndroidCliPort {
  return {
    layout: vi.fn(),
    layoutDiff: vi.fn(),
    captureScreen: vi.fn(() => Promise.resolve(commandResult())),
    resolveScreen: vi.fn()
  };
}

const config = {
  pollIntervalMs: 100,
  stablePolls: 2,
  timeoutMs: 500
};

describe("IdleWaiter", () => {
  it("becomes stable after consecutive empty Layout Diffs", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff)
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
      polls: 2,
      durationMs: 100,
      strategy: "hybrid",
      fallbackUsed: false,
      frameActivityDetected: false,
      samplingDurationMs: 0
    });
    expect(cli.layoutDiff).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cli.layoutDiff).mock.calls.map(([options]) => (
      options.timeoutMs
    ))).toEqual([500, 400]);
    expect(clock.sleeps).toEqual([100]);
  });

  it("resets the stable counter after a new change", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "new-change" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(new IdleWaiter(
      cli,
      new FakeClock(),
      "emulator-5554"
    ).waitUntilIdle(config))
      .resolves.toMatchObject({ status: "stable", polls: 3 });
  });

  it("times out with the last nonempty Diff", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff).mockImplementation(() => Promise.resolve([
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
    const cli = androidCli();
    const clock = new FakeClock();
    vi.mocked(cli.layoutDiff).mockImplementation(() => {
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
    const cli = androidCli();
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
    expect(cli.layoutDiff).not.toHaveBeenCalled();
  });

  it("returns cancelled when aborted between polls", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff).mockResolvedValue([]);
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
    const cli = androidCli();
    vi.mocked(cli.layoutDiff).mockImplementation((options) => {
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
    expect(cli.layoutDiff).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(cli.layoutDiff).mock.calls;
    expect(calls[2]?.[0]).toMatchObject({
      stabilityBackend: "uiautomator"
    });
  });

  it("continues polling when confirmation shows layout changes", async () => {
    const cli = androidCli();
    let confirmCount = 0;
    vi.mocked(cli.layoutDiff).mockImplementation((options) => {
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
      polls: 4,
      durationMs: 300
    });
  });

  it("does not declare frame stability without structural confirmation", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff).mockImplementation((options) => {
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
    const cli = androidCli();
    let structuralPolls = 0;
    vi.mocked(cli.layoutDiff).mockImplementation((options) => {
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
      polls: 4
    });
  });

  it("uses only structural polling for layoutDiff strategy", async () => {
    const cli = androidCli();
    vi.mocked(cli.layoutDiff)
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
    expect(vi.mocked(cli.layoutDiff).mock.calls.every(([options]) => (
      options.stabilityBackend === "uiautomator"
    ))).toBe(true);
  });
});
