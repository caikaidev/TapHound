import { describe, expect, it, vi } from "vitest";

import {
  VerifyRuntime,
  type StepRunnerLike,
  type VerifyInput,
  type VerifyProgressEvent
} from "../../../src/application/runtime/verify-runtime.js";
import {
  StepRunner,
  type ReplayBinding
} from "../../../src/application/runtime/step-runner.js";
import { adbRuntimeCapabilities } from "../../../src/adapters/runtime/adb-runtime-backend.js";
import { UiSnapshotError } from "../../../src/adapters/ui/ui-snapshot-error.js";
import type { AppProcess } from "../../../src/domain/app-process.js";
import type { Journey } from "../../../src/domain/journey.js";
import { hashJourney } from "../../../src/domain/report.js";
import type { LoadedKnowledgeBundle } from "../../../src/ports/knowledge-registry.js";
import type { RuntimeSession } from "../../../src/ports/runtime-backend.js";
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
  it("starts with an empty Binding map on every independent verify call", async () => {
    const test = runtimeFixture();
    const maps: Map<string, ReplayBinding>[] = [];
    const runtime = new VerifyRuntime({
      ...test.dependencies,
      createStepRunner: (options): StepRunner => {
        if (options.bindings === undefined) throw new Error("Missing Replay bindings");
        maps.push(options.bindings);
        return new StepRunner(options);
      }
    });
    const first = await runtime.verify(input());
    expect(first.status).toBe("passed");
    expect(maps).toHaveLength(1);
    maps[0]?.set("old", {
      value: "secret", valueType: "identifier", sourceStepIndex: 0,
      window: { from: "runStart" }, startedAtMs: 0,
      evidenceSha256: "a".repeat(64)
    });
    vi.mocked(test.adb.currentActivity).mockReset()
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValue("com.example.app.SearchActivity");
    const second = await runtime.verify(input());
    expect(second.status).toBe("passed");
    expect(maps).toHaveLength(2);
    expect(maps[1]).not.toBe(maps[0]);
    expect(maps[1]?.has("old")).toBe(false);
  });

  it("binds an allOf event to a marker from a previous step and publishes condition evidence", async () => {
    const test = runtimeFixture();
    const original = runtimeJourney.steps[0];
    if (original === undefined) throw new Error("Journey fixture needs a step");
    const foreground = vi.mocked(test.adb.foregroundComponent);
    const originalForeground = foreground.getMockImplementation();
    foreground.mockImplementation(async (options) => {
      const current = await originalForeground?.(options);
      const stream = vi.mocked(test.adb.startLogcat).mock.calls[0]?.[0];
      stream?.onStdoutLine(
        '09-15 15:00:00.123  42  42 D Search: {"event":"results","fields":{"query":"hello"}}'
      );
      return current ?? {
        packageName: "com.example.app", activity: "com.example.app.SearchActivity"
      };
    });
    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      journey: {
        ...runtimeJourney,
        steps: [original, {
          action: "wait", markerId: "search-start",
          activity: {
            before: "com.example.app.SearchActivity",
            after: "com.example.app.SearchActivity"
          }
        }],
        checkpoints: [{
          version: 1, id: "search-ready", name: "Search ready", status: "inferred",
          stepIndex: 1, expect: { allOf: [
            { kind: "absentElement", locator: { resourceId: "spinner" } },
            { kind: "logcatEvent", expect: {
              type: "logcatEvent", tag: "Search", event: "results",
              fields: { query: "hello" }, unique: true,
              window: { from: "marker", markerId: "search-start" }
            } }
          ], timeoutMs: 200 }
        }]
      }
    });
    expect(result.status).toBe("passed");
    expect(result.report.steps[1]?.marker).toMatchObject({
      id: "search-start"
    });
    expect(result.report.checkpoints).toMatchObject([{
      id: "search-ready", status: "passed", conditions: [
        { kind: "absentElement", status: "passed",
          evidenceRef: "checkpoints/search-ready-0-ui.json" },
        { kind: "logcatEvent", status: "passed", matchedCount: 1,
          evidenceRef: "logcat-default.txt" }
      ]
    }]);
    expect(result.report.checkpoints?.[0]?.conditions[1]?.startedAtMs)
      .toBe(result.report.steps[1]?.marker?.startedAtMs);
  });

  it("evaluates step and final Checkpoints in order and includes their evidence", async () => {
    const test = runtimeFixture();
    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      journey: {
        ...runtimeJourney,
        checkpoints: [{
          version: 1,
          id: "after-search",
          name: "After search",
          stepIndex: 0,
          status: "inferred",
          expect: {
            allOf: [
              { kind: "activity", expected: "com.example.app.SearchActivity" },
              { kind: "visibleElement", locator: { resourceId: "search" } },
              { kind: "absentElement", locator: { resourceId: "spinner" } }
            ],
            timeoutMs: 100
          }
        }, {
          version: 1,
          id: "at-end",
          name: "At end",
          status: "inferred",
          expect: {
            allOf: [
              { kind: "visibleElement", locator: { resourceId: "search" } }
            ],
            timeoutMs: 100
          }
        }]
      }
    });
    expect(result.status).toBe("passed");
    expect(result.report.checkpoints).toMatchObject([
      { id: "after-search", stepIndex: 0, status: "passed", conditions: [
        { kind: "activity", status: "passed" },
        { kind: "visibleElement", status: "passed" },
        { kind: "absentElement", status: "passed" }
      ] },
      { id: "at-end", status: "passed" }
    ]);
    expect(result.report.checkpoints?.[1]).not.toHaveProperty("stepIndex");
    expect(result.report.journey.sha256).not.toBe(hashJourney(runtimeJourney));
  });

  it("fails the run and stops before the next step on a failed Checkpoint", async () => {
    const test = runtimeFixture();
    const first = runtimeJourney.steps[0];
    if (first === undefined) throw new Error("Journey fixture needs a step");
    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      journey: {
        ...runtimeJourney,
        steps: [first, {
          action: "wait",
          activity: {
            before: "com.example.app.SearchActivity",
            after: "com.example.app.SearchActivity"
          }
        }],
        checkpoints: [{
          version: 1,
          id: "missing-result",
          name: "Missing result",
          stepIndex: 0,
          status: "inferred",
          expect: {
            allOf: [
              { kind: "visibleElement", locator: { resourceId: "not-present" } }
            ],
            timeoutMs: 100
          }
        }]
      }
    });
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      report: {
        primaryFailure: {
          code: "CHECKPOINT_FAILED",
          phase: "checkpoint",
          stepIndex: 0
        },
        checkpoints: [{ id: "missing-result", status: "failed" }]
      }
    });
    expect(result.report.steps).toHaveLength(1);
    expect(result.report.artifacts.screenshots).toHaveLength(1);
  });

  it("fails closed when a Screen Checkpoint has no Knowledge loader", async () => {
    const test = runtimeFixture();
    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      journey: {
        ...runtimeJourney,
        checkpoints: [{
          version: 1,
          id: "search-screen",
          name: "Search screen",
          stepIndex: 0,
          status: "inferred",
          expect: {
            allOf: [
              { kind: "screen", expected: "search" }
            ],
            timeoutMs: 100
          }
        }]
      }
    });
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      report: {
        primaryFailure: { code: "CHECKPOINT_UNRESOLVED" },
        checkpoints: [{
          id: "search-screen",
          status: "unresolved",
          conditions: [{ kind: "screen", status: "unresolved" }]
        }]
      }
    });
  });

  it("writes ordinary Journey Screen evidence from a Knowledge Checkpoint", async () => {
    const test = runtimeFixture();
    const knowledge: LoadedKnowledgeBundle = {
      index: {
        version: 1,
        packageName: "com.example.app",
        revision: 1,
        anchors: [],
        screens: []
      },
      indexSha256: "a".repeat(64),
      knowledgeHash: "b".repeat(64),
      anchors: [{
        version: 1,
        id: "search-element",
        status: "observed",
        roles: ["screenIdentity"],
        identity: {
          kind: "element",
          locator: { resourceId: "search" }
        }
      }],
      screens: [{
        version: 1,
        id: "search",
        status: "observed",
        requiredAnchors: ["search-element"],
        optionalAnchors: [],
        forbiddenAnchors: [],
        predicates: []
      }]
    };
    const loadKnowledge = vi.fn(() => Promise.resolve(knowledge));
    const result = await new VerifyRuntime({
      ...test.dependencies,
      loadKnowledge
    }).verify({
      ...input(),
      journey: {
        ...runtimeJourney,
        checkpoints: [{
          version: 1,
          id: "search-screen",
          name: "Search screen",
          status: "inferred",
          expect: {
            allOf: [
              { kind: "screen", expected: "search" }
            ],
            timeoutMs: 100
          }
        }]
      }
    });
    expect(result).toMatchObject({
      status: "passed",
      report: {
        checkpoints: [{ id: "search-screen", status: "passed" }],
        screens: [{ screen: "search", status: "matched" }]
      }
    });
    expect(loadKnowledge).toHaveBeenCalledOnce();
  });
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
    expect(result.report.checkpoints).toBeUndefined();
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
      "step-layout",
      "screenshot",
      "logcat-stop",
      "report"
    ]);
    expect(test.artifacts.session.text.has("logcat-default.txt")).toBe(true);
    expect(test.artifacts.session.published).toBe(true);
  });

  it("reports replay progress through the progress callback", async () => {
    const test = runtimeFixture();
    const events: VerifyProgressEvent[] = [];

    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      progress: (event): void => {
        events.push(event);
      }
    });

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(events).toEqual([
      { stage: "preparing" },
      { stage: "replaying", stepIndex: 0, stepCount: 1 },
      { stage: "collecting" }
    ]);
  });

  it("still reports collecting progress when a step fails", async () => {
    const test = runtimeFixture();
    let layoutCalls = 0;
    vi.mocked(test.androidCli.layout)
      .mockImplementation(() => {
        test.order.push(layoutCalls === 0 ? "baseline" : "step-layout");
        layoutCalls += 1;
        return Promise.resolve([]);
      });
    const events: VerifyProgressEvent[] = [];

    const result = await new VerifyRuntime(test.dependencies).verify({
      ...input(),
      progress: (event): void => {
        events.push(event);
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      report: { primaryFailure: { code: "LOCATOR_NOT_FOUND" } }
    });
    expect(events).toEqual([
      { stage: "preparing" },
      { stage: "replaying", stepIndex: 0, stepCount: 1 },
      { stage: "collecting" }
    ]);
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
    let layoutCalls = 0;
    vi.mocked(test.androidCli.layout)
      .mockImplementation(() => {
        test.order.push(layoutCalls === 0 ? "baseline" : "step-layout");
        layoutCalls += 1;
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

  it.each([
    ["UI_SNAPSHOT_FAILED", "Appium page source capture failed: timeout"],
    ["UI_BACKEND_UNAVAILABLE", "Appium UiAutomator2 session could not be opened"]
  ] as const)("reports %s as an environment error, not a replay failure", async (code, message) => {
    const test = runtimeFixture();
    test.dependencies.createStepRunner = (): StepRunnerLike => ({
      run: vi.fn<StepRunner["run"]>(() => Promise.reject(
        new UiSnapshotError(code, "appium-uiautomator2", message, { terminal: true })
      ))
    });

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "error",
      exitCode: 3,
      report: { status: "error", primaryFailure: { code, message } }
    });
    expect(test.order.at(-1)).toBe("report");
  });

  it("fails closed with RUNTIME_CAPABILITY_MISSING when the session cannot stream logcat", async () => {
    const test = runtimeFixture();
    const session: RuntimeSession = {
      descriptor: {
        id: "mobile-mcp",
        adapterVersion: "test-v1",
        configSha256: "0".repeat(64),
        capabilities: { ...adbRuntimeCapabilities(), logs: false }
      },
      deviceSerial: "emulator-5554",
      openUiSnapshots: (options) => test.uiSnapshots.open({
        deviceSerial: "emulator-5554",
        timeoutMs: options?.timeoutMs ?? 5000,
        ...(options?.backend === undefined ? {} : { backend: options.backend }),
        ...(options?.cacheEnabled === undefined
          ? {}
          : { cacheEnabled: options.cacheEnabled }),
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      }),
      isInstalled: () => Promise.resolve(true),
      launchApp: () => Promise.resolve(commandResult()),
      forceStop: () => Promise.resolve(commandResult()),
      currentActivity: undefined,
      deviceIdentity: undefined,
      foregroundComponent: undefined,
      appProcesses: undefined,
      windowTopology: undefined,
      tap: () => Promise.resolve(commandResult()),
      longClick: () => Promise.resolve(commandResult()),
      swipe: () => Promise.resolve(commandResult()),
      back: () => Promise.resolve(commandResult()),
      inputText: () => Promise.resolve(commandResult()),
      startLogcat: undefined,
      dumpLogcat: undefined,
      captureScreenshot: () => Promise.resolve(commandResult()),
      annotatedScreens: undefined,
      uiStability: test.androidCli,
      startActivityByIntent: undefined,
      close: () => Promise.resolve()
    };
    test.dependencies.sessions = {
      openSession: (): Promise<RuntimeSession> => Promise.resolve(session)
    };

    const result = await new VerifyRuntime(test.dependencies).verify(input());

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 3,
      report: {
        primaryFailure: {
          code: "RUNTIME_CAPABILITY_MISSING",
          phase: "collection"
        },
        layers: { run: "failed", collection: "failed" },
        steps: []
      }
    });
    expect(result.report.primaryFailure?.message).toContain("startLogcat");
    expect(result.report.primaryFailure?.message).toContain("mobile-mcp");
    expect(result.report.artifacts.screenshots)
      .toEqual([{ role: "default", path: "screenshot-default.png" }]);
    expect(test.order).toEqual(["report"]);
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
      "step-layout@emulator-5554",
      "screenshot@emulator-5554",
      "logcat-stop@emulator-5554",
      "step-layout@emulator-5556",
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
      "step-layout@emulator-5554",
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
