import type { Expectation } from "../../domain/journey.js";
import type { LayoutElement } from "../../domain/layout.js";
import type {
  ActivityExpectationObservation,
  ExpectationObservationBoundary,
  ExpectationObservationInput,
  LayoutExpectationObservation
} from "./expectation-evaluator.js";

/**
 * Engine-specific observation of the App under a bound identity. Each call
 * re-checks the foreground package and process identity and throws when they
 * no longer match; `layout` also re-checks them after the capture.
 */
export interface GuardedExpectationProbe<
  TObservation extends { layout: readonly LayoutElement[] }
> {
  activity: (input: ExpectationObservationInput) => Promise<string>;
  layout: (input: ExpectationObservationInput) => Promise<TObservation>;
  /** Errors that must propagate instead of failing the observation. */
  rethrow?: (error: unknown) => boolean;
}

/**
 * Expectation observations shared by generated Replay and Generation. A guard
 * violation becomes a failed observation, which the evaluator reports as
 * `EXPECT_ACTIVITY_FAILED` or `EXPECT_ELEMENT_FAILED`. The first Layout
 * observation reuses the settled post-action Layout, which the engine has
 * already guarded, instead of capturing the same screen again.
 */
export class GuardedExpectationObservations<
  TObservation extends { layout: readonly LayoutElement[] }
> {
  private seed: TObservation | undefined;
  private last: TObservation | undefined;

  public constructor(
    private readonly probe: GuardedExpectationProbe<TObservation>,
    settled?: TObservation
  ) {
    this.seed = settled;
  }

  public boundary(): ExpectationObservationBoundary {
    return {
      activity: async (input): Promise<ActivityExpectationObservation> => {
        try {
          return {
            status: "observed",
            activity: await this.probe.activity(input)
          };
        } catch (error) {
          return this.failed(error, "Expect Activity observation failed");
        }
      },
      layout: async (input): Promise<LayoutExpectationObservation> => {
        if (this.seed !== undefined) {
          this.last = this.seed;
          this.seed = undefined;
          return { status: "observed", layout: this.last.layout };
        }
        try {
          this.last = await this.probe.layout(input);
          return { status: "observed", layout: this.last.layout };
        } catch (error) {
          return this.failed(error, "Expect Layout observation failed");
        }
      }
    };
  }

  /** The Layout observation the element expectation last resolved against. */
  public lastLayoutObservation(): TObservation | undefined {
    return this.last;
  }

  private failed(
    error: unknown,
    fallback: string
  ): { status: "failed"; message: string } {
    if (this.probe.rethrow?.(error) === true) throw error;
    return {
      status: "failed",
      message: error instanceof Error ? error.message : fallback
    };
  }
}

/**
 * The foreground a passing expectation leaves behind. An `element`
 * expectation is proven on the guarded Layout it resolved against and an
 * `activity` expectation on the guarded Activity it matched; log expectations
 * prove nothing about the screen, so the foreground must be re-checked.
 */
export function settledExpectationForeground(
  expectation: Expectation,
  afterActivity: string
): { activity: string; proven: boolean } {
  switch (expectation.type) {
  case "activity":
    return { activity: expectation.value, proven: true };
  case "element":
    return { activity: afterActivity, proven: true };
  case "logcat":
  case "logcatEvent":
    return { activity: afterActivity, proven: false };
  }
}
