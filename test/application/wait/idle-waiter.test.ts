import { describe, expect, it, vi } from "vitest";

import { IdleWaiter } from "../../../src/application/wait/idle-waiter.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { commandResult } from "../../fakes/process-runner.js";

function androidCli(): AndroidCliPort {
  return {
    describeProject: vi.fn(),
    runApp: vi.fn(() => Promise.resolve(commandResult())),
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
      polls: 3,
      durationMs: 200
    });
    expect(cli.layoutDiff).toHaveBeenCalledTimes(3);
    expect(vi.mocked(cli.layoutDiff).mock.calls.map(([options]) => (
      options.timeoutMs
    ))).toEqual([500, 400, 300]);
    expect(clock.sleeps).toEqual([100, 100]);
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
      .resolves.toMatchObject({ status: "stable", polls: 4 });
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
      durationMs: 300,
      lastDiff: [{ id: "still-changing" }]
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
      lastDiff: []
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
});
