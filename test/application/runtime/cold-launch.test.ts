import { describe, expect, it, vi } from "vitest";

import { coldLaunchApp } from "../../../src/application/runtime/cold-launch.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { commandResult } from "../../fakes/process-runner.js";

const input = {
  packageName: "com.example.app",
  activity: "com.example.app.MainActivity",
  deviceSerial: "emulator-5554",
  pollIntervalMs: 100,
  timeoutMs: 1_000
};

function device(overrides: Partial<AdbPort> = {}): AdbPort {
  return {
    forceStop: vi.fn(() => Promise.resolve(commandResult())),
    launchActivity: vi.fn(() => Promise.resolve(commandResult())),
    appProcesses: vi.fn(() => Promise.resolve([
      { pid: 42, name: "com.example.app" }
    ])),
    ...overrides
  } as unknown as AdbPort;
}

describe("coldLaunchApp", () => {
  it("resets, launches, and returns the ready process ids", async () => {
    const adb = device();

    await expect(coldLaunchApp(adb, new FakeClock(), input)).resolves
      .toMatchObject({ status: "ready", pids: [42] });
    expect(adb.launchActivity).toHaveBeenCalledWith(expect.objectContaining({
      activity: "com.example.app.MainActivity"
    }));
  });

  it("does not launch when the reset fails", async () => {
    const adb = device({
      forceStop: vi.fn(() => Promise.resolve(commandResult({ exitCode: 3 })))
    });

    await expect(coldLaunchApp(adb, new FakeClock(), input)).resolves.toEqual({
      status: "failed",
      stage: "reset",
      message: "App reset exited with code 3"
    });
    expect(adb.launchActivity).not.toHaveBeenCalled();
  });

  it("reports an am start error printed on stdout as a launch failure", async () => {
    const adb = device({
      launchActivity: vi.fn(() => Promise.resolve(commandResult({
        stdout: "Error: Activity class does not exist."
      })))
    });

    await expect(coldLaunchApp(adb, new FakeClock(), input)).resolves.toEqual({
      status: "failed",
      stage: "launch",
      message: "Error: Activity class does not exist."
    });
  });

  it("fails at the process stage when the app never starts", async () => {
    const clock = new FakeClock();
    const adb = device({ appProcesses: vi.fn(() => Promise.resolve([])) });

    await expect(coldLaunchApp(adb, clock, input)).resolves.toEqual({
      status: "failed",
      stage: "process",
      message: "App process was not found after launch"
    });
  });

  it("reports cancellation while waiting for the process", async () => {
    const controller = new AbortController();
    const adb = device({
      appProcesses: vi.fn(() => {
        controller.abort();
        return Promise.resolve([]);
      })
    });

    await expect(coldLaunchApp(adb, new FakeClock(), {
      ...input,
      signal: controller.signal
    })).resolves.toEqual({ status: "cancelled" });
  });
});
