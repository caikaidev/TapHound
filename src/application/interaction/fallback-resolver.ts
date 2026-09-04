import type { FailureCode } from "../../domain/failure.js";
import type { JourneyStep } from "../../domain/journey.js";
import type { Point } from "../../domain/geometry.js";
import type {
  AnnotatedScreenResolverPort
} from "../../ports/annotated-screen-resolver.js";
import type { ScreenshotPort } from "../../ports/screenshot.js";

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
      label?: string | undefined;
      annotatedScreenshotPath?: string | undefined;
    };

export class FallbackResolver {
  public constructor(
    private readonly screenshots: ScreenshotPort,
    private readonly annotatedScreens: AnnotatedScreenResolverPort,
    private readonly deviceSerial: string
  ) {}

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

    const capture = await this.screenshots.capture({
      outputPath: annotatedScreenshotPath,
      annotate: true,
      deviceSerial: this.deviceSerial,
      ...(signal === undefined ? {} : { signal })
    });
    if (capture.exitCode !== 0) {
      return {
        status: "failed",
        code: "LOCATOR_NOT_FOUND",
        message: capture.stderr.trim() || "Annotated screen capture failed"
      };
    }

    try {
      const point = await this.annotatedScreens.resolve(
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
          : "Annotated label resolution failed",
        label: step.fallback.label,
        annotatedScreenshotPath
      };
    }
  }
}
