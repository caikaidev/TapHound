import { describe, expect, it, vi } from "vitest";

import {
  VerifyRuntime,
  type StepRunnerLike,
  type VerifyInput
} from "../../../src/application/runtime/verify-runtime.js";
import type { StepRunner } from "../../../src/application/runtime/step-runner.js";
import type { AppProcess } from "../../../src/domain/app-process.js";
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
    deviceSerial: "emulator-5554",
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
          screenshot: "screenshot.png",
          logcat: "logcat.txt",
          stepLogs: ["steps/001-logcat.txt"]
        }
      }
    });
    expect(result.report.schemaVersion).toBe(2);
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
    expect(test.artifacts.session.text.has("logcat.txt")).toBe(true);
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
        version: 1,
        name: "core/launch-home",
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
    vi.mocked(test.androidCli.captureScreen).mockImplementation(() => {
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
