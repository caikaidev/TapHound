import { describe, expect, it, vi } from "vitest";

import { FallbackResolver } from "../../../src/application/interaction/fallback-resolver.js";
import type { JourneyStep } from "../../../src/domain/journey.js";
import type { AndroidCliPort } from "../../../src/ports/android-cli.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";

const checkpoint = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

function commandResult(exitCode = 0): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: exitCode === 0 ? "" : "capture failed",
    durationMs: 1,
    timedOut: false,
    cancelled: false
  };
}

function androidCli(exitCode = 0): AndroidCliPort {
  return {
    describeProject: vi.fn(),
    runApp: vi.fn(),
    layout: vi.fn(),
    layoutDiff: vi.fn(),
    captureScreen: vi.fn(() => Promise.resolve(commandResult(exitCode))),
    resolveScreen: vi.fn(() => Promise.resolve({ x: 120, y: 240 }))
  };
}

describe("FallbackResolver", () => {
  it.each(["click", "longClick"] as const)(
    "resolves the recorded annotated label for %s",
    async (action) => {
      const cli = androidCli();
      const resolver = new FallbackResolver(cli, "emulator-5554");
      const step: JourneyStep = action === "click"
        ? {
            action,
            locator: { resourceId: "missing" },
            fallback: { type: "annotatedLabel", label: "#7" },
            activity: checkpoint
          }
        : {
            action,
            locator: { resourceId: "missing" },
            fallback: { type: "annotatedLabel", label: "#7" },
            durationMs: 800,
            activity: checkpoint
          };

      const result = await resolver.resolve(step, "/tmp/step-annotated.png");

      expect(result).toEqual({
        status: "found",
        point: { x: 120, y: 240 },
        source: "annotatedLabel",
        label: "#7",
        annotatedScreenshotPath: "/tmp/step-annotated.png"
      });
      expect(vi.mocked(cli.captureScreen)).toHaveBeenCalledWith(
        {
          outputPath: "/tmp/step-annotated.png",
          annotate: true,
          deviceSerial: "emulator-5554"
        }
      );
      expect(vi.mocked(cli.resolveScreen)).toHaveBeenCalledWith(
        "/tmp/step-annotated.png",
        "#7",
        undefined
      );
    }
  );

  it("reports unavailable when the step has no explicit fallback", async () => {
    const cli = androidCli();
    const resolver = new FallbackResolver(cli, "emulator-5554");

    await expect(resolver.resolve({
      action: "click",
      locator: { resourceId: "missing" },
      activity: checkpoint
    }, "/tmp/step-annotated.png")).resolves.toEqual({
      status: "unavailable"
    });

    expect(vi.mocked(cli.captureScreen)).not.toHaveBeenCalled();
  });

  it("returns a typed failure when annotated capture fails", async () => {
    const resolver = new FallbackResolver(androidCli(1), "emulator-5554");

    await expect(resolver.resolve({
      action: "click",
      locator: { resourceId: "missing" },
      fallback: { type: "annotatedLabel", label: "#7" },
      activity: checkpoint
    }, "/tmp/step-annotated.png")).resolves.toMatchObject({
      status: "failed",
      code: "LOCATOR_NOT_FOUND"
    });
  });
});
