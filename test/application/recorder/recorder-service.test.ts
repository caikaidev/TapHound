import { describe, expect, it, vi } from "vitest";

import { RecorderService } from "../../../src/application/recorder/recorder-service.js";
import type { Journey } from "../../../src/domain/journey.js";
import type { RecorderPromptPort } from "../../../src/ports/recorder-prompt.js";
import type { RecorderAction } from "../../../src/ports/recorder-prompt.js";
import type { JourneyWriterPort } from "../../../src/ports/journey-writer.js";
import type { GradlePort } from "../../../src/ports/gradle.js";
import {
  runtimeConfig,
  runtimeFixture
} from "../../fakes/runtime-fixture.js";
import { commandResult } from "../../fakes/process-runner.js";

function prompt(actions: RecorderAction[]): RecorderPromptPort {
  return {
    selectAction: vi.fn(() => Promise.resolve(actions.shift() ?? "finish")),
    selectTarget: vi.fn(() => Promise.resolve("search")),
    inputText: vi.fn(() => Promise.resolve("hello world")),
    selectSwipeDirection: vi.fn(() => Promise.resolve("up" as const)),
    longClickDuration: vi.fn(() => Promise.resolve(800)),
    swipeOptions: vi.fn(() => Promise.resolve({
      distancePercent: 0.6,
      durationMs: 300
    })),
    selectFallbackLabel: vi.fn(() => Promise.resolve(undefined)),
    notifyFailure: vi.fn(() => Promise.resolve())
  };
}

function writer(): JourneyWriterPort & { journeys: Journey[] } {
  const journeys: Journey[] = [];
  return {
    journeys,
    write: vi.fn((_path: string, journey: Journey) => {
      journeys.push(journey);
      return Promise.resolve();
    })
  };
}

describe("RecorderService", () => {
  it("launches the App and saves Activity checkpoints for successful Actions", async () => {
    const runtime = runtimeFixture();
    const recorderPrompt = prompt(["click", "finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    const result = await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Recorded search",
      outputPath: "/project/journeys/search.json"
    });

    expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
    expect(journeyWriter.journeys).toEqual([{
      version: 1,
      name: "Recorded search",
      steps: [{
        action: "click",
        locator: { resourceId: "search" },
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.SearchActivity"
        }
      }]
    }]);
    expect(journeyWriter.journeys[0]?.steps[0]?.expect).toBeUndefined();
    expect(runtime.order.slice(0, 3)).toEqual(["build", "describe", "run"]);
  });

  it("does not append an Action that fails on the device", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.adb.tap)
      .mockResolvedValueOnce(commandResult({ exitCode: 1, stderr: "tap failed" }))
      .mockResolvedValueOnce(commandResult());
    const recorderPrompt = prompt(["click", "click", "finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    const result = await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Retry",
      outputPath: "/project/retry.json"
    });

    expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
    expect(recorderPrompt.notifyFailure).toHaveBeenCalledWith("tap failed");
    expect(journeyWriter.journeys[0]?.steps).toHaveLength(1);
  });

  it("stops recording when a successful Action leaves the device in an unverified state", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.androidCli.layoutDiff).mockResolvedValue([
      { changed: "text" }
    ]);
    const recorderPrompt = prompt(["click", "finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    const result = await service.record({
      config: {
        ...runtimeConfig,
        idle: { pollIntervalMs: 100, stablePolls: 2, timeoutMs: 100 }
      },
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Unstable",
      outputPath: "/project/unstable.json"
    });

    expect(result).toEqual({
      status: "failed",
      stepsRecorded: 0,
      message: "Layout did not become stable before timeout"
    });
    expect(recorderPrompt.selectAction).toHaveBeenCalledTimes(1);
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });

  it("records an explicitly selected annotated fallback label", async () => {
    const runtime = runtimeFixture();
    const recorderPrompt = prompt(["click", "finish"]);
    vi.mocked(recorderPrompt.selectFallbackLabel).mockResolvedValue("#7");
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Fallback",
      outputPath: "/project/fallback.json"
    });

    expect(journeyWriter.journeys[0]?.steps[0]).toMatchObject({
      fallback: { type: "annotatedLabel", label: "#7" }
    });
    expect(runtime.androidCli.captureScreen).toHaveBeenCalledWith(
      {
        outputPath: "/project/fallback.annotated.png",
        annotate: true,
        deviceSerial: "emulator-5554",
        timeoutMs: 500
      }
    );
  });

  it("records every supported first-stage Action and its required parameters", async () => {
    const runtime = runtimeFixture();
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: prompt([
        "longClick",
        "inputText",
        "swipe",
        "back",
        "wait",
        "finish"
      ]),
      journeyWriter
    });

    const result = await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "All Actions",
      outputPath: "/project/all-actions.json"
    });

    expect(result).toMatchObject({ status: "completed", stepsRecorded: 5 });
    expect(journeyWriter.journeys[0]?.steps).toMatchObject([{
      action: "longClick",
      durationMs: 800
    }, {
      action: "inputText",
      text: "hello world"
    }, {
      action: "swipe",
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300
    }, {
      action: "back"
    }, {
      action: "wait"
    }]);
  });

  it("does not enter the prompt loop when launch preparation fails", async () => {
    const runtime = runtimeFixture();
    const failingGradle: GradlePort = {
      build: () => Promise.resolve(commandResult({
        exitCode: 1,
        stderr: "compile failed"
      }))
    };
    const recorderPrompt = prompt(["finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: failingGradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    const result = await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Failed",
      outputPath: "/project/failed.json"
    });

    expect(result).toEqual({
      status: "failed",
      stepsRecorded: 0,
      message: "compile failed"
    });
    expect(recorderPrompt.selectAction).not.toHaveBeenCalled();
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });

  it("cancels without writing a partial Journey", async () => {
    const runtime = runtimeFixture();
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: prompt(["cancel"]),
      journeyWriter
    });

    const result = await service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Cancelled",
      outputPath: "/project/cancelled.json"
    });

    expect(result).toEqual({ status: "cancelled", stepsRecorded: 0 });
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });
});
