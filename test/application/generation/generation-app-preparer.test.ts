import { describe, expect, it, vi } from "vitest";

import {
  GenerationAppPreparer
} from "../../../src/application/generation/generation-app-preparer.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import { FakeClock } from "../../fakes/fake-clock.js";

const config: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 100,
    stablePolls: 2,
    timeoutMs: 5_000
  },
  artifactsDir: ".taphound/build/runs"
};

function commandResult(
  overrides: Partial<CommandResult> = {}
): CommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    signal: null,
    ...overrides
  };
}

function adb(overrides: Partial<AdbPort> = {}): AdbPort {
  return {
    forceStop: vi.fn(() => Promise.resolve(commandResult())),
    launchActivity: vi.fn(() => Promise.resolve(commandResult())),
    appProcesses: vi.fn(() => Promise.resolve([{
      pid: 42,
      name: "com.example.app"
    }])),
    currentActivity: vi.fn(() => Promise.resolve(
      "com.example.app.MainActivity"
    )),
    ...overrides
  } as unknown as AdbPort;
}

describe("GenerationAppPreparer", () => {
  it("cold-launches the configured Activity and waits for readiness", async () => {
    const device = adb();
    const service = new GenerationAppPreparer(device, new FakeClock());

    await expect(service.prepare({
      config,
      deviceSerial: "emulator-5554"
    })).resolves.toBeUndefined();

    expect(device.forceStop).toHaveBeenCalledWith(expect.objectContaining({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    }));
    expect(device.launchActivity).toHaveBeenCalledWith(expect.objectContaining({
      activity: "com.example.app.MainActivity"
    }));
    expect(device.appProcesses).toHaveBeenCalled();
    expect(device.currentActivity).toHaveBeenCalled();
  });

  it("fails before launch when force-stop fails", async () => {
    const launchActivity = vi.fn(() => Promise.resolve(commandResult()));
    const service = new GenerationAppPreparer(adb({
      forceStop: vi.fn(() => Promise.resolve(commandResult({
        exitCode: 1,
        stderr: "reset denied"
      }))),
      launchActivity
    }), new FakeClock());

    await expect(service.prepare({
      config,
      deviceSerial: "emulator-5554"
    })).rejects.toThrow("reset denied");
    expect(launchActivity).not.toHaveBeenCalled();
  });

  it("reports launch command failures", async () => {
    const service = new GenerationAppPreparer(adb({
      launchActivity: vi.fn(() => Promise.resolve(commandResult({
        exitCode: 1,
        stderr: "activity missing"
      })))
    }), new FakeClock());

    await expect(service.prepare({
      config,
      deviceSerial: "emulator-5554"
    })).rejects.toThrow("activity missing");
  });
});
