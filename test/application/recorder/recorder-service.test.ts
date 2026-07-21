import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { parseLayout } from "../../../src/adapters/android-cli/layout-parser.js";
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
import { FakeClock } from "../../fakes/fake-clock.js";
import { commandResult } from "../../fakes/process-runner.js";

const realLayoutFixture = fileURLToPath(
  new URL("../../fixtures/android-cli/layout-output.json", import.meta.url)
);

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
    notifyFailure: vi.fn(() => Promise.resolve()),
    selectScrollContainer: vi.fn(() => Promise.resolve("scroll_container")),
    scrollTargetDecision: vi.fn(() => Promise.resolve({ kind: "cancel" } as const))
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

async function recordScrollToJourney(): Promise<Journey> {
  const runtime = runtimeFixture();
  const container = {
    id: "message_list",
    resourceId: "message_list",
    scrollable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 400 },
    children: []
  };
  const bubble = {
    id: "message_bubble",
    resourceId: "message_bubble",
    text: "target",
    enabled: true,
    bounds: { left: 0, top: 100, right: 100, bottom: 150 },
    children: []
  };
  let layoutReads = 0;
  vi.mocked(runtime.androidCli.layout).mockImplementation(() => {
    layoutReads += 1;
    return Promise.resolve(layoutReads <= 2 ? [container] : [container, bubble]);
  });
  const recorderPrompt = prompt(["scrollTo", "finish"]);
  vi.mocked(recorderPrompt.selectScrollContainer).mockResolvedValue("message_list");
  vi.mocked(recorderPrompt.scrollTargetDecision)
    .mockResolvedValueOnce({ kind: "scrollMore" })
    .mockResolvedValueOnce({ kind: "select", id: "message_bubble" });
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
    journeyName: "Scroll to bubble",
    outputPath: "/project/scroll-to.json"
  });

  expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
  expect(runtime.adb.swipe).toHaveBeenCalledTimes(1);
  const journey = journeyWriter.journeys[0];
  if (journey === undefined) {
    throw new Error("No journey was written");
  }
  return journey;
}

describe("RecorderService", () => {
  it("executes the second selected element when Android CLI keys repeat", async () => {
    const runtime = runtimeFixture();
    const layout = parseLayout(await readFile(realLayoutFixture, "utf8"));
    vi.mocked(runtime.androidCli.layout).mockResolvedValue(layout);
    const recorderPrompt = prompt(["click", "finish"]);
    vi.mocked(recorderPrompt.selectTarget).mockImplementation((choices) => {
      const second = choices[1];
      if (second === undefined) {
        throw new Error("Expected a second Recorder target");
      }
      return Promise.resolve(second.id);
    });
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
      journeyName: "Repeated keys",
      outputPath: "/project/repeated-keys.json"
    });

    expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
    expect(journeyWriter.journeys[0]?.steps[0]).toMatchObject({
      action: "click",
      locator: { resourceId: "results" }
    });
  });

  it("launches the App and saves Activity checkpoints for successful Actions", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.MainActivity")
      .mockResolvedValueOnce("com.example.app.SearchActivity");
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

  it("records from the stable Activity reached after launch", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.adb.currentActivity)
      .mockResolvedValueOnce("com.example.app.HomeActivity")
      .mockResolvedValueOnce("com.example.app.SearchActivity");
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
      journeyName: "Authenticated search",
      outputPath: "/project/journeys/search.json"
    });

    expect(result).toMatchObject({ status: "completed", stepsRecorded: 1 });
    expect(journeyWriter.journeys[0]?.steps[0]?.activity).toEqual({
      before: "com.example.app.HomeActivity",
      after: "com.example.app.SearchActivity"
    });
  });

  it("waits for a delayed App process before entering the prompt loop", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.adb.pid)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(42);
    const recorderPrompt = prompt(["cancel"]);
    vi.mocked(recorderPrompt.selectAction).mockImplementation(() => {
      expect(runtime.adb.pid).toHaveBeenCalledTimes(2);
      return Promise.resolve("cancel");
    });
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    await expect(service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Delayed process",
      outputPath: "/project/delayed.json"
    })).resolves.toEqual({ status: "cancelled", stepsRecorded: 0 });
    expect(runtime.dependencies.clock).toMatchObject({ sleeps: [100] });
    expect(runtime.androidCli.layout).toHaveBeenCalled();
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });

  it("does not prompt when the App process is missing after launch", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.adb.pid).mockResolvedValue(null);
    const recorderPrompt = prompt(["finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    await expect(service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Missing process",
      outputPath: "/project/missing.json"
    })).resolves.toEqual({
      status: "failed",
      stepsRecorded: 0,
      message: "App process was not found after launch"
    });
    expect(recorderPrompt.selectAction).not.toHaveBeenCalled();
  });

  it("cancels process startup waiting without writing or prompting", async () => {
    const runtime = runtimeFixture();
    const clock = new FakeClock();
    const controller = new AbortController();
    vi.mocked(runtime.adb.pid).mockResolvedValue(null);
    clock.onSleep = (): void => {
      controller.abort();
    };
    const recorderPrompt = prompt(["finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    await expect(service.record({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Cancelled startup",
      outputPath: "/project/cancelled-startup.json",
      signal: controller.signal
    })).resolves.toEqual({ status: "cancelled", stepsRecorded: 0 });
    expect(recorderPrompt.selectAction).not.toHaveBeenCalled();
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });

  it("does not prompt when the startup layout remains unstable", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.androidCli.layoutDiff).mockResolvedValue([
      { changed: "text" }
    ]);
    const recorderPrompt = prompt(["finish"]);
    const journeyWriter = writer();
    const service = new RecorderService({
      gradle: runtime.gradle,
      androidCli: runtime.androidCli,
      adb: runtime.adb,
      clock: runtime.dependencies.clock,
      prompt: recorderPrompt,
      journeyWriter
    });

    await expect(service.record({
      config: {
        ...runtimeConfig,
        idle: { pollIntervalMs: 100, stablePolls: 2, timeoutMs: 100 }
      },
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Unstable startup",
      outputPath: "/project/unstable-startup.json"
    })).resolves.toEqual({
      status: "failed",
      stepsRecorded: 0,
      message: "Layout did not become stable before timeout"
    });
    expect(recorderPrompt.selectAction).not.toHaveBeenCalled();
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
    vi.mocked(runtime.androidCli.layoutDiff)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ changed: "text" }]);
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

  it("records a scrollTo step with maxSwipes derived from swipes used", async () => {
    const journey = await recordScrollToJourney();
    expect(journey.steps[0]).toMatchObject({
      action: "scrollTo",
      locator: { resourceId: "message_bubble" },
      container: { resourceId: "message_list" },
      direction: "up",
      maxSwipes: 6
    });
  });

  it("stops the live scroll at 30 swipes with a notifyFailure and writes no scrollTo step", async () => {
    const runtime = runtimeFixture();
    const container = {
      id: "message_list",
      resourceId: "message_list",
      scrollable: true,
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 400 },
      children: []
    };
    vi.mocked(runtime.androidCli.layout).mockResolvedValue([container]);
    const recorderPrompt = prompt(["scrollTo", "cancel"]);
    vi.mocked(recorderPrompt.selectScrollContainer).mockResolvedValue("message_list");
    let scrollMoreCount = 0;
    vi.mocked(recorderPrompt.scrollTargetDecision).mockImplementation(() => {
      scrollMoreCount += 1;
      return Promise.resolve(
        scrollMoreCount <= 31 ? { kind: "scrollMore" } : { kind: "cancel" }
      );
    });
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
      journeyName: "Scroll cap",
      outputPath: "/project/scroll-cap.json"
    });

    expect(result).toEqual({ status: "cancelled", stepsRecorded: 0 });
    expect(recorderPrompt.notifyFailure).toHaveBeenCalledWith(
      "scrollTo reached the 30-swipe recording cap; the Journey would not replay"
    );
    expect(journeyWriter.write).not.toHaveBeenCalled();
  });
});
