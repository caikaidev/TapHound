import { describe, expect, it, vi } from "vitest";

import {
  VerifyRuntime,
  type StepRunnerLike,
  type VerifyInput
} from "../../../src/application/runtime/verify-runtime.js";
import type { StepRunner } from "../../../src/application/runtime/step-runner.js";
import type { AppProcess } from "../../../src/domain/app-process.js";
import type { Journey } from "../../../src/domain/journey.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import {
  runtimeConfig,
  runtimeFixture,
  runtimeJourney
} from "../../fakes/runtime-fixture.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { commandResult } from "../../fakes/process-runner.js";

function input(signal?: AbortSignal): VerifyInput {
  return {
    config: runtimeConfig,
    journey: runtimeJourney,
    projectRoot: "/project",
    devices: [{ role: "default", deviceSerial: "emulator-5554" }],
    toolVersions: { node: "24.3.0", adb: "1.0.41", android: "1.0.0" },
    ...(signal === undefined ? {} : { signal })
  };
}

const alive: readonly AppProcess[] = [
  { pid: 42, name: "com.example.app" },
  { pid: 77, name: "com.example.app:remote" }
];

describe("VerifyRuntime", () => {
  it("orchestrates the full deterministic verification order", async () => {
    const test = runtimeFixture();

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "passed",
      exitCode: 0,
      report: {
        status: "passed",
        layers: {
          run: "passed",
          structural: "passed",
          activityCheckpoint: "passed",
          explicitExpect: "passed",
          collection: "passed"
        },
        artifacts: {
          screenshots: [{ role: "default", path: "screenshot-default.png" }],
          logcats: [{ role: "default", path: "logcat-default.txt" }],
          stepLogs: ["steps/001-logcat.txt"]
        }
      }
    });
    expect(result.report.schemaVersion).toBe(4);
    expect(result.report.environment.devices).toEqual([
      {
        role: "default",
        deviceSerial: "emulator-5554",
        uiBackend: {
          id: "system-uiautomator",
          adapterVersion: "test-v1",
          configSha256: "0".repeat(64)
        }
      }
    ]);
    expect(test.uiSnapshots.open).toHaveBeenCalledWith({
      deviceSerial: "emulator-5554",
      timeoutMs: runtimeConfig.idle.timeoutMs,
      backend: "auto",
      cacheEnabled: true
    });
    expect(test.order).toEqual([
      "install",
      "logcat-start",
      "force-stop",
      "launch",
      "pid",
      "pid",
      "activity-main",
      "baseline",
      "activity-main",
      "step-layout",
      "action",
      "idle",
      "idle",
      "idle",
      "pid",
      "activity-search",
      "screenshot",
      "logcat-stop",
      "report"
    ]);
    expect(test.artifacts.session.text.has("logcat-default.txt")).toBe(true);
    expect(test.artifacts.session.published).toBe(true);
  });

  it("waits for the first Journey Activity after a launch redirect", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.SplashActivity")
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValueOnce("com.example.app.SearchActivity");

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(test.dependencies.clock).toMatchObject({
      sleeps: [100, 100, 100]
    });
  });

  it("replays a stable Home readiness anchor after a Splash redirect", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.SplashActivity")
      .mockResolvedValue("com.example.app.HomeActivity");
    vi.mocked(test.androidCli.layout).mockResolvedValue([{
      id: "home-root",
      resourceId: "home_root",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    }]);

    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      journey: {
        version: 2,
        name: "core/launch-home",
        devices: [{ role: "default" }],
        steps: [{
          action: "wait",
          activity: {
            before: "com.example.app.HomeActivity",
            after: "com.example.app.HomeActivity"
          },
          expect: {
            type: "element",
            locator: { resourceId: "home_root" },
            timeoutMs: 3_000
          }
        }]
      }
    });

    expect(result).toMatchObject({
      status: "passed",
      exitCode: 0,
      report: {
        steps: [{
          action: "wait",
          status: "passed",
          expectation: {
            type: "element",
            status: "passed"
          }
        }]
      }
    });
  });

  it("waits for a delayed App process within one launch-readiness budget", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.appProcesses)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue(alive);

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(test.dependencies.clock).toMatchObject({
      currentTime: 600,
      sleeps: [100, 100, 100, 100, 100, 100]
    });
    expect(test.adb.appProcesses).toHaveBeenNthCalledWith(5, {
      packageName: runtimeConfig.run.packageName,
      deviceSerial: "emulator-5554",
      timeoutMs: 100
    });
    expect(test.adb.appProcesses).toHaveBeenNthCalledWith(6, {
      packageName: runtimeConfig.run.packageName,
      deviceSerial: "emulator-5554",
      timeoutMs: 100
    });
  });

  it("fails launch readiness when the first Journey Activity is not reached", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      report: {
        primaryFailure: {
          code: "APP_LAUNCH_FAILED",
          phase: "readiness"
        },
        steps: []
      }
    });
    expect(result.report.primaryFailure?.message)
      .toContain("com.example.app.MainActivity");
    expect(result.report.primaryFailure?.message)
      .toContain("com.example.app.SplashActivity");
    expect(test.dependencies.clock).toMatchObject({
      sleeps: [100, 100, 100, 100, 100]
    });
  });

  it("fails launch readiness when the App process exits during redirect", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.appProcesses)
      .mockResolvedValueOnce(alive)
      .mockResolvedValueOnce(alive)
      .mockResolvedValueOnce([]);
    vi.mocked(test.adb.currentActivity)
      .mockResolvedValue("com.example.app.SplashActivity");

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      report: {
        primaryFailure: {
          code: "APP_LAUNCH_FAILED",
          message: "App process exited before reaching the first Journey Activity",
          phase: "readiness"
        },
        steps: []
      }
    });
    expect(test.order).not.toContain("baseline");
    expect(test.order).not.toContain("action");
  });

  it("fails fast when the app is not installed but still finalizes best-effort evidence", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.isInstalled).mockImplementation(() => {
      test.order.push("install");
      return Promise.resolve(false);
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "error",
      exitCode: 3,
      report: {
        primaryFailure: { code: "APP_NOT_INSTALLED", phase: "install" },
        layers: { run: "failed" }
      }
    });
    expect(test.order).toEqual(["install", "screenshot", "report"]);
  });

  it("finalizes Logcat when App launch fails", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.launchActivity).mockImplementation(() => {
      test.order.push("launch");
      return Promise.resolve(commandResult({ exitCode: 1, stderr: "launch failed" }));
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result.report.primaryFailure?.code).toBe("APP_LAUNCH_FAILED");
    expect(test.order).toEqual([
      "install",
      "logcat-start",
      "force-stop",
      "launch",
      "screenshot",
      "logcat-stop",
      "report"
    ]);
  });

  it("preserves a step failure when screenshot collection also fails", async () => {
    const test = runtimeFixture();
    vi.mocked(test.androidCli.layout)
      .mockImplementationOnce(() => {
        test.order.push("baseline");
        return Promise.resolve([]);
      })
      .mockImplementationOnce(() => {
        test.order.push("step-layout");
        return Promise.resolve([]);
      });
    vi.mocked(test.screenshots.capture).mockImplementation(() => {
      test.order.push("screenshot");
      return Promise.resolve(commandResult({ exitCode: 1, stderr: "capture failed" }));
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      report: {
        primaryFailure: { code: "LOCATOR_NOT_FOUND" },
        secondaryErrors: [{ code: "COLLECTION_FAILED", message: "capture failed" }],
        layers: { structural: "failed", collection: "failed" }
      }
    });
  });

  it("preserves Logcat startup as primary and stops replay when collection cannot start", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.startLogcat).mockImplementation(() => {
      test.order.push("logcat-start");
      const completion = Promise.resolve(commandResult({
        exitCode: 1,
        stderr: "logcat unavailable"
      }));
      return {
        started: completion,
        completion,
        stop: (): Promise<CommandResult> => completion
      };
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      report: {
        primaryFailure: {
          code: "COLLECTION_FAILED",
          message: "logcat unavailable"
        },
        steps: []
      }
    });
    expect(test.order).not.toContain("force-stop");
    expect(test.order).not.toContain("launch");
    expect(test.order).not.toContain("action");
  });

  it("accepts SIGTERM when TapHound intentionally stops the Logcat stream", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.startLogcat).mockImplementation((options) => {
      test.order.push("logcat-start");
      options.onStdoutLine("07-19 10:00:00.000  42  42 I TapHound: ready");
      const completion = Promise.resolve(commandResult({
        exitCode: null,
        signal: "SIGTERM",
        terminationRequested: true
      }));
      return {
        started: Promise.resolve(undefined),
        completion,
        stop: (): Promise<CommandResult> => {
          test.order.push("logcat-stop");
          return completion;
        }
      };
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "passed",
      exitCode: 0,
      report: { layers: { collection: "passed" } }
    });
  });

  it("maps readiness command errors to APP_LAUNCH_FAILED", async () => {
    const test = runtimeFixture();
    vi.mocked(test.adb.appProcesses).mockRejectedValue(new Error("ADB disconnected"));

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      report: {
        primaryFailure: {
          code: "APP_LAUNCH_FAILED",
          message: "ADB disconnected"
        }
      }
    });
  });

  it("maps cancellation while waiting for the App process to INTERNAL_ERROR", async () => {
    const test = runtimeFixture();
    const clock = new FakeClock();
    const controller = new AbortController();
    vi.mocked(test.adb.appProcesses).mockResolvedValue([]);
    clock.onSleep = (): void => {
      controller.abort();
    };
    test.dependencies.clock = clock;

    const result = await new VerifyRuntime(test.dependencies)
      .verify(input(controller.signal));

    expect(result).toMatchObject({
      status: "error",
      exitCode: 4,
      report: {
        primaryFailure: {
          code: "INTERNAL_ERROR",
          message: "Verification was cancelled",
          phase: "readiness"
        }
      }
    });
    expect(test.order.at(-1)).toBe("report");
  });

  it("maps cancellation to a stable INTERNAL_ERROR result and finalizes", async () => {
    const test = runtimeFixture();
    test.dependencies.createStepRunner = (): StepRunnerLike => ({
      run: vi.fn<StepRunner["run"]>(() => Promise.resolve({
        status: "cancelled",
        report: {
          index: 0,
          action: "click",
          status: "notRun",
          startedAtMs: 0,
          finishedAtMs: 0,
          durationMs: 0
        }
      }))
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "error",
      exitCode: 4,
      report: { primaryFailure: { code: "INTERNAL_ERROR" } }
    });
    expect(test.order.at(-1)).toBe("report");
  });
});

const MAIN = "com.example.app.MainActivity";
const SEARCH = "com.example.app.SearchActivity";

function clickStep(
  device: string
): Journey["steps"][number] {
  return {
    action: "click",
    device,
    locator: { resourceId: "search" },
    activity: { before: MAIN, after: SEARCH }
  };
}

describe("VerifyRuntime multi-device", () => {
  const twoDeviceJourney: Journey = {
    version: 2,
    name: "CrossDevice",
    devices: [{ role: "sender" }, { role: "receiver" }],
    steps: [clickStep("sender"), clickStep("receiver")]
  };

  function multiInput(
    journey: Journey,
    devices: VerifyInput["devices"]
  ): VerifyInput {
    return {
      ...input(),
      journey,
      devices
    };
  }

  it("sets up each declared device and interleaves steps across roles", async () => {
    const test = runtimeFixture({ serials: ["emulator-5554", "emulator-5556"] });

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(twoDeviceJourney, [
        { role: "sender", deviceSerial: "emulator-5554" },
        { role: "receiver", deviceSerial: "emulator-5556" }
      ])
    );

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.report.environment.devices).toEqual([
      {
        role: "sender",
        deviceSerial: "emulator-5554",
        uiBackend: {
          id: "system-uiautomator",
          adapterVersion: "test-v1",
          configSha256: "0".repeat(64)
        }
      },
      {
        role: "receiver",
        deviceSerial: "emulator-5556",
        uiBackend: {
          id: "system-uiautomator",
          adapterVersion: "test-v1",
          configSha256: "0".repeat(64)
        }
      }
    ]);
    expect(result.report.steps.map((step) => step.device))
      .toEqual(["sender", "receiver"]);
    expect(result.report.artifacts.screenshots).toEqual([
      { role: "sender", path: "screenshot-sender.png" },
      { role: "receiver", path: "screenshot-receiver.png" }
    ]);
    expect(result.report.artifacts.logcats).toEqual([
      { role: "sender", path: "logcat-sender.txt" },
      { role: "receiver", path: "logcat-receiver.txt" }
    ]);
    expect(test.artifacts.session.text.has("logcat-sender.txt")).toBe(true);
    expect(test.artifacts.session.text.has("logcat-receiver.txt")).toBe(true);
    expect(test.uiSnapshots.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(test.uiSnapshots.open).mock.calls[0]?.[0].deviceSerial)
      .toBe("emulator-5554");
    expect(vi.mocked(test.uiSnapshots.open).mock.calls[1]?.[0].deviceSerial)
      .toBe("emulator-5556");
    expect(vi.mocked(test.adb.tap).mock.calls.map((call) => call[1]))
      .toEqual(["emulator-5554", "emulator-5556"]);
    expect(test.order).toEqual([
      "install@emulator-5554",
      "logcat-start@emulator-5554",
      "force-stop@emulator-5554",
      "launch@emulator-5554",
      "pid@emulator-5554",
      "pid@emulator-5554",
      "activity-main@emulator-5554",
      "baseline@emulator-5554",
      "install@emulator-5556",
      "logcat-start@emulator-5556",
      "force-stop@emulator-5556",
      "launch@emulator-5556",
      "pid@emulator-5556",
      "pid@emulator-5556",
      "activity-main@emulator-5556",
      "baseline@emulator-5556",
      "activity-main@emulator-5554",
      "step-layout@emulator-5554",
      "action@emulator-5554",
      "idle@emulator-5554",
      "idle@emulator-5554",
      "idle@emulator-5554",
      "pid@emulator-5554",
      "activity-search@emulator-5554",
      "activity-main@emulator-5556",
      "step-layout@emulator-5556",
      "action@emulator-5556",
      "idle@emulator-5556",
      "idle@emulator-5556",
      "idle@emulator-5556",
      "pid@emulator-5556",
      "activity-search@emulator-5556",
      "screenshot@emulator-5554",
      "logcat-stop@emulator-5554",
      "screenshot@emulator-5556",
      "logcat-stop@emulator-5556",
      "report"
    ]);
  });

  it("routes repeated interleaved steps back to their device runtime", async () => {
    const test = runtimeFixture({ serials: ["emulator-5554", "emulator-5556"] });
    const scripts = new Map<string, string[]>([
      ["emulator-5554", [MAIN, MAIN, SEARCH, MAIN, SEARCH]],
      ["emulator-5556", [MAIN, MAIN, SEARCH]]
    ]);
    vi.mocked(test.adb.currentActivity).mockImplementation((identity) => {
      const value = scripts.get(identity.deviceSerial)?.shift() ?? SEARCH;
      return Promise.resolve(value);
    });

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(
        {
          version: 2,
          name: "CrossDevicePingPong",
          devices: [{ role: "sender" }, { role: "receiver" }],
          steps: [
            clickStep("sender"),
            clickStep("receiver"),
            clickStep("sender")
          ]
        },
        [
          { role: "sender", deviceSerial: "emulator-5554" },
          { role: "receiver", deviceSerial: "emulator-5556" }
        ]
      )
    );

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.report.steps.map((step) => step.device))
      .toEqual(["sender", "receiver", "sender"]);
    expect(vi.mocked(test.adb.tap).mock.calls.map((call) => call[1]))
      .toEqual(["emulator-5554", "emulator-5556", "emulator-5554"]);
  });

  it("stops at the first device whose install check fails but still collects per-device evidence", async () => {
    const test = runtimeFixture({ serials: ["emulator-5554", "emulator-5556"] });
    vi.mocked(test.adb.isInstalled).mockImplementation((identity) => {
      test.order.push(`install@${identity.deviceSerial}`);
      return Promise.resolve(identity.deviceSerial !== "emulator-5556");
    });

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(twoDeviceJourney, [
        { role: "sender", deviceSerial: "emulator-5554" },
        { role: "receiver", deviceSerial: "emulator-5556" }
      ])
    );

    expect(result).toMatchObject({
      status: "error",
      exitCode: 3,
      report: {
        primaryFailure: {
          code: "APP_NOT_INSTALLED",
          phase: "install",
          message: "Package com.example.app is not installed on emulator-5556"
        },
        steps: []
      }
    });
    expect(result.report.artifacts.screenshots).toEqual([
      { role: "sender", path: "screenshot-sender.png" },
      { role: "receiver", path: "screenshot-receiver.png" }
    ]);
    expect(result.report.artifacts.logcats).toEqual([
      { role: "sender", path: "logcat-sender.txt" }
    ]);
    expect(test.order).toEqual([
      "install@emulator-5554",
      "logcat-start@emulator-5554",
      "force-stop@emulator-5554",
      "launch@emulator-5554",
      "pid@emulator-5554",
      "pid@emulator-5554",
      "activity-main@emulator-5554",
      "baseline@emulator-5554",
      "install@emulator-5556",
      "screenshot@emulator-5554",
      "logcat-stop@emulator-5554",
      "screenshot@emulator-5556",
      "report"
    ]);
  });

  it("fails with DEVICE_ROLE_UNMAPPED when a declared role has no assignment", async () => {
    const test = runtimeFixture({ serials: ["emulator-5554", "emulator-5556"] });

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(twoDeviceJourney, [
        { role: "sender", deviceSerial: "emulator-5554" }
      ])
    );

    expect(result).toMatchObject({
      status: "error",
      exitCode: 3,
      report: {
        primaryFailure: {
          code: "DEVICE_ROLE_UNMAPPED",
          phase: "runtime",
          message: "No device mapping for journey role(s): receiver"
        },
        steps: [],
        layers: { structural: "failed" },
        environment: {
          devices: [{ role: "sender", deviceSerial: "emulator-5554" }]
        },
        artifacts: { screenshots: [], logcats: [] }
      }
    });
    expect(test.order).toEqual(["report"]);
  });

  it("fails with CONFIG_INVALID for assignments the Journey does not declare", async () => {
    const test = runtimeFixture();

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(runtimeJourney, [
        { role: "default", deviceSerial: "emulator-5554" },
        { role: "rogue", deviceSerial: "emulator-5556" }
      ])
    );

    expect(result).toMatchObject({
      status: "error",
      exitCode: 2,
      report: {
        primaryFailure: {
          code: "CONFIG_INVALID",
          message: "Device assignment references a role the Journey does not declare: rogue"
        },
        steps: []
      }
    });
    expect(result.report.environment.devices).toEqual([
      { role: "default", deviceSerial: "emulator-5554" },
      { role: "rogue", deviceSerial: "emulator-5556" }
    ]);
    expect(test.order).toEqual(["report"]);
  });

  it("fails with CONFIG_INVALID when one role is assigned twice", async () => {
    const test = runtimeFixture();

    const result = await new VerifyRuntime(test.dependencies).verify(
      multiInput(runtimeJourney, [
        { role: "default", deviceSerial: "emulator-5554" },
        { role: "default", deviceSerial: "emulator-5556" }
      ])
    );

    expect(result).toMatchObject({
      status: "error",
      exitCode: 2,
      report: {
        primaryFailure: {
          code: "CONFIG_INVALID",
          message: "Duplicate device assignment for role: default"
        },
        environment: {
          devices: [{ role: "default", deviceSerial: "emulator-5554" }]
        }
      }
    });
    expect(test.order).toEqual(["report"]);
  });

  it("rejects an empty device assignment list", async () => {
    const test = runtimeFixture();

    await expect(new VerifyRuntime(test.dependencies).verify(
      multiInput(runtimeJourney, [])
    )).rejects.toThrow(
      "VerifyInput.devices requires at least one device assignment"
    );
  });
});
