import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { AndroidCliPort, Point } from "../../ports/android-cli.js";

export type FallbackResolution =
  | { status: "unavailable" }
  | {
      status: "found";
      point: Point;
      source: "annotatedLabel";
      label: string;
      annotatedScreenshotPath: string;
    }
  | {
      status: "failed";
      code: Extract<FailureCode, "LOCATOR_NOT_FOUND">;
      message: string;
    };

export class FallbackResolver {
  public constructor(private readonly androidCli: AndroidCliPort) {}

  public async resolve(
    step: JourneyStep,
    annotatedScreenshotPath: string,
    signal?: AbortSignal
  ): Promise<FallbackResolution> {
    if (
      (step.action !== "click" && step.action !== "longClick")
      || step.fallback === undefined
    ) {
      return { status: "unavailable" };
    }

    const capture = await this.androidCli.captureScreen(
      annotatedScreenshotPath,
      true,
      signal
    );
    if (capture.exitCode !== 0) {
      return {
        status: "failed",
        code: "LOCATOR_NOT_FOUND",
        message: capture.stderr.trim() || "Annotated screen capture failed"
      };
    }

    try {
      const point = await this.androidCli.resolveScreen(
        annotatedScreenshotPath,
        step.fallback.label,
        signal
      );
      return {
        status: "found",
        point,
        source: "annotatedLabel",
        label: step.fallback.label,
        annotatedScreenshotPath
      };
    } catch (error) {
      return {
        status: "failed",
        code: "LOCATOR_NOT_FOUND",
        message: error instanceof Error
          ? error.message
          : "Annotated label resolution failed"
      };
    }
  }
}
