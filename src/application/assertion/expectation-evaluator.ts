import { createHash } from "node:crypto";

import type { FailureCode } from "../../domain/failure.js";
import type { Expectation } from "../../domain/journey.js";
import type { StepReport } from "../../domain/report.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { AdbPort } from "../../ports/adb.js";
import type { Clock } from "../../ports/clock.js";
import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import type {
  LogcatCollector,
  LogcatLine
} from "../collector/logcat-collector.js";
import {
  matchesLogcatEvent,
  requestErrorClassFor
} from "../collector/logcat-event.js";
import { resolveLocator } from "../locator/locator-resolver.js";

export interface ExpectationContext {
  packageName: string;
  deviceSerial: string;
  stepStartedAt: number;
  runStartedAt?: number | undefined;
  markers?: ReadonlyMap<string, number> | undefined;
}

export interface ExpectationObservationInput {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type ActivityExpectationObservation =
  | { status: "observed"; activity: string }
  | { status: "failed"; message: string };

export type LayoutExpectationObservation =
  | { status: "observed"; layout: readonly LayoutElement[] }
  | { status: "failed"; message: string };

export interface ExpectationObservationBoundary {
  activity?: (input: ExpectationObservationInput) => Promise<
    ActivityExpectationObservation
  >;
  layout?: (input: ExpectationObservationInput) => Promise<
    LayoutExpectationObservation
  >;
}

export type ExpectationResult =
  | {
      status: "passed";
      type: Expectation["type"];
      durationMs: number;
      actual?: string | undefined;
      matchedLine?: string | undefined;
      logcatEvent?: NonNullable<StepReport["expectation"]>["logcatEvent"];
    }
  | {
      status: "failed";
      type: Expectation["type"];
      code: Extract<
        FailureCode,
        | "EXPECT_ACTIVITY_FAILED"
        | "EXPECT_ELEMENT_FAILED"
        | "EXPECT_LOGCAT_FAILED"
        | "EXPECT_LOGCAT_AMBIGUOUS"
      >;
      message: string;
      durationMs: number;
      actual?: string | undefined;
      logcatEvent?: NonNullable<StepReport["expectation"]>["logcatEvent"];
    }
  | {
      status: "cancelled";
      type: Expectation["type"];
      durationMs: number;
    };

type ElementExpectation = Extract<Expectation, { type: "element" }>;

export function elementPredicateMismatch(
  element: LayoutElement,
  expectation: ElementExpectation
): string | undefined {
  if (
    expectation.enabled !== undefined
    && element.enabled !== expectation.enabled
  ) {
    return `element ${element.id} enabled=${element.enabled ? "true" : "false"}`
      + `, expected enabled=${expectation.enabled ? "true" : "false"}`;
  }
  if (
    expectation.clickable !== undefined
    && (element.clickable === true) !== expectation.clickable
  ) {
    return `element ${element.id} clickable=${element.clickable === true ? "true" : "false"}`
      + `, expected clickable=${expectation.clickable ? "true" : "false"}`;
  }
  return undefined;
}

/**
 * Whether an element or activity expectation already holds on a settled
 * screen, before any action: a touch without capability proof cannot claim
 * an outcome that was already there.
 */
export function expectationHoldsOnScreen(
  expectation: Expectation,
  layout: readonly LayoutElement[],
  activity: string
): boolean {
  if (expectation.type === "activity") {
    return expectation.value === activity;
  }
  if (expectation.type !== "element") {
    return false;
  }
  const resolution = resolveLocator(layout, expectation.locator, {
    requireEnabled: false
  });
  if (expectation.absent === true) {
    return resolution.status === "failed"
      && resolution.code === "LOCATOR_NOT_FOUND"
      && resolution.evidenceMismatch !== true;
  }
  return resolution.status === "found"
    && elementPredicateMismatch(resolution.element, expectation) === undefined;
}

function matchesLogcat(
  line: LogcatLine,
  expectation: Extract<Expectation, { type: "logcat" }>,
  pattern: RegExp | string
): boolean {
  if (
    line.tag !== expectation.tag
    || (
      expectation.level !== undefined
      && line.level !== expectation.level
    )
  ) {
    return false;
  }
  const content = line.message ?? line.raw;
  return typeof pattern === "string"
    ? content.includes(pattern)
    : pattern.test(content);
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class ExpectationEvaluator {
  private readonly matchedEvents = new WeakMap<object, LogcatLine>();
  public constructor(
    private readonly adb: AdbPort,
    private readonly uiSnapshotProvider: UiSnapshotProvider,
    private readonly logcat: LogcatCollector,
    private readonly clock: Clock,
    private readonly pollIntervalMs = 100
  ) {}

  /** Internal runtime-only evidence, deliberately absent from JSON results. */
  public matchedEventFor(result: ExpectationResult): LogcatLine | undefined {
    return this.matchedEvents.get(result);
  }

  public async evaluate(
    expectation: Expectation,
    context: ExpectationContext,
    signal?: AbortSignal,
    observations: ExpectationObservationBoundary = {}
  ): Promise<ExpectationResult> {
    const startedAt = this.clock.now();
    const logPattern = expectation.type === "logcat"
      ? (
          expectation.match === "regex"
            ? new RegExp(expectation.pattern)
            : expectation.pattern
        )
      : undefined;
    let actual: string | undefined;
    let elementObservation: string | undefined;
    const window = expectation.type === "logcatEvent"
      ? expectation.window
      : undefined;
    const windowStart = window === undefined
      ? undefined
      : window.from === "stepStart"
        ? context.stepStartedAt
        : window.from === "runStart"
          ? context.runStartedAt
          : context.markers?.get(window.markerId);
    if (window !== undefined && windowStart === undefined) {
      return {
        status: "failed",
        type: "logcatEvent",
        code: "EXPECT_LOGCAT_FAILED",
        message: "Logcat event window source is unavailable",
        durationMs: 0
      };
    }
    const eventEvidence = (matched: readonly LogcatLine[]): NonNullable<
      StepReport["expectation"]
    >["logcatEvent"] => window === undefined || windowStart === undefined
      ? undefined
      : {
          matchedCount: matched.length,
          ...(matched.length !== 1 || matched[0] === undefined
            ? {}
            : {
                matchedLineSha256: createHash("sha256")
                  .update(matched[0].raw)
                  .digest("hex"),
                ...(requestErrorClassFor(matched[0]) === undefined
                  ? {} : { requestErrorClass: requestErrorClassFor(matched[0]) })
              }),
          window,
          startedAtMs: windowStart
        };
    let eventMatches: LogcatLine[] = [];

    for (;;) {
      if (isAborted(signal)) {
        return {
          status: "cancelled",
          type: expectation.type,
          durationMs: this.clock.now() - startedAt
        };
      }

      const commandTimeoutMs = Math.max(
        1,
        expectation.timeoutMs - (this.clock.now() - startedAt)
      );

      try {
        switch (expectation.type) {
        case "activity": {
          const observation = observations.activity === undefined
            ? {
                status: "observed" as const,
                activity: await this.adb.currentActivity({
                  packageName: context.packageName,
                  deviceSerial: context.deviceSerial,
                  ...(signal === undefined ? {} : { signal }),
                  timeoutMs: commandTimeoutMs
                })
              }
            : await observations.activity({
                timeoutMs: commandTimeoutMs,
                ...(signal === undefined ? {} : { signal })
              });
          if (isAborted(signal)) {
            return {
              status: "cancelled",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt
            };
          }
          if (observation.status === "failed") {
            return {
              status: "failed",
              type: expectation.type,
              code: "EXPECT_ACTIVITY_FAILED",
              message: observation.message,
              durationMs: this.clock.now() - startedAt
            };
          }
          actual = observation.activity;
          if (actual === expectation.value) {
            return {
              status: "passed",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt,
              actual
            };
          }
          break;
        }
        case "element": {
          const observation = observations.layout === undefined
            ? {
                status: "observed" as const,
                layout: (await this.uiSnapshotProvider.capture({
                  reason: "expect",
                  freshness: "sameMutationEpoch",
                  ...(signal === undefined ? {} : { signal }),
                  timeoutMs: commandTimeoutMs
                })).roots
              }
            : await observations.layout({
                timeoutMs: commandTimeoutMs,
                ...(signal === undefined ? {} : { signal })
              });
          if (isAborted(signal)) {
            return {
              status: "cancelled",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt
            };
          }
          if (observation.status === "failed") {
            return {
              status: "failed",
              type: expectation.type,
              code: "EXPECT_ELEMENT_FAILED",
              message: observation.message,
              durationMs: this.clock.now() - startedAt
            };
          }
          const resolution = resolveLocator(
            observation.layout,
            expectation.locator,
            { requireEnabled: false }
          );
          if (expectation.absent === true) {
            if (
              resolution.status === "failed"
              && resolution.code === "LOCATOR_NOT_FOUND"
              && resolution.evidenceMismatch !== true
            ) {
              return {
                status: "passed",
                type: expectation.type,
                durationMs: this.clock.now() - startedAt
              };
            }
            elementObservation = resolution.status === "found"
              ? `expected absent element matched by ${resolution.matchedBy}`
              : `expected absent element still resolvable: ${resolution.message}`;
          } else if (resolution.status === "found") {
            const mismatch = elementPredicateMismatch(
              resolution.element,
              expectation
            );
            if (mismatch === undefined) {
              return {
                status: "passed",
                type: expectation.type,
                durationMs: this.clock.now() - startedAt
              };
            }
            elementObservation = mismatch;
          } else {
            elementObservation = resolution.message;
          }
          break;
        }
        case "logcat": {
          const matched = this.logcat
            .linesBetween(context.stepStartedAt, this.clock.now())
            .find((line) => matchesLogcat(line, expectation, logPattern ?? ""));
          if (matched !== undefined) {
            return {
              status: "passed",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt,
              matchedLine: matched.raw
            };
          }
          if (!this.logcat.completeSince(context.stepStartedAt)) {
            const metadata = this.logcat.metadata();
            return {
              status: "failed",
              type: expectation.type,
              code: "EXPECT_LOGCAT_FAILED",
              message: "Logcat evidence is incomplete in the step window"
                + ` (droppedLines=${String(metadata.droppedLines ?? 0)},`
                + ` droppedBytes=${String(metadata.droppedBytes ?? 0)},`
                + ` lastDroppedAtMs=${String(metadata.lastDroppedAtMs ?? "unknown")})`,
              durationMs: this.clock.now() - startedAt
            };
          }
          break;
        }
        case "logcatEvent": {
          if (windowStart === undefined || !this.logcat.completeSince(windowStart)) {
            return {
              status: "failed",
              type: expectation.type,
              code: "EXPECT_LOGCAT_FAILED",
              message: "Logcat event evidence is incomplete in the declared window",
              durationMs: this.clock.now() - startedAt,
              logcatEvent: eventEvidence(eventMatches)
            };
          }
          eventMatches = this.logcat
            .linesBetween(
              windowStart, Math.min(this.clock.now(), startedAt + expectation.timeoutMs)
            )
            .filter((line) => matchesLogcatEvent(line, expectation));
          if (eventMatches.length > 1) {
            return {
              status: "failed",
              type: expectation.type,
              code: "EXPECT_LOGCAT_AMBIGUOUS",
              message: "Logcat event appeared more than once in the declared window",
              durationMs: this.clock.now() - startedAt,
              logcatEvent: eventEvidence(eventMatches)
            };
          }
          break;
        }
        }
      } catch (error) {
        const elapsed = this.clock.now() - startedAt;
        if (isAborted(signal)) {
          return {
            status: "cancelled",
            type: expectation.type,
            durationMs: elapsed
          };
        }
        if (elapsed >= expectation.timeoutMs) {
          const codes = {
            activity: "EXPECT_ACTIVITY_FAILED",
            element: "EXPECT_ELEMENT_FAILED",
            logcat: "EXPECT_LOGCAT_FAILED",
            logcatEvent: "EXPECT_LOGCAT_FAILED"
          } as const;
          return {
            status: "failed",
            type: expectation.type,
            code: codes[expectation.type],
            message: `${expectation.type} Expect command exceeded its timeout`,
            durationMs: elapsed,
            ...(actual === undefined ? {} : { actual })
          };
        }
        throw error;
      }

      const elapsed = this.clock.now() - startedAt;
      if (elapsed >= expectation.timeoutMs) {
        const codes = {
          activity: "EXPECT_ACTIVITY_FAILED",
          element: "EXPECT_ELEMENT_FAILED",
          logcat: "EXPECT_LOGCAT_FAILED",
          logcatEvent: "EXPECT_LOGCAT_FAILED"
        } as const;
        if (expectation.type === "logcatEvent" && eventMatches.length === 1) {
          const result: ExpectationResult = {
            status: "passed",
            type: expectation.type,
            durationMs: elapsed,
            logcatEvent: eventEvidence(eventMatches)
          };
          if (eventMatches[0] !== undefined) {
            this.matchedEvents.set(result, eventMatches[0]);
          }
          return result;
        }
        return {
          status: "failed",
          type: expectation.type,
          code: codes[expectation.type],
          message: expectation.type === "logcatEvent"
            ? "Logcat event did not appear before timeout"
            : expectation.type === "element"
              ? elementObservation === undefined
                ? "element Expect did not match before timeout"
                : `element Expect did not match before timeout: ${elementObservation}`
              : `${expectation.type} Expect did not match before timeout`,
          durationMs: elapsed,
          ...(expectation.type === "logcatEvent"
            ? { logcatEvent: eventEvidence(eventMatches) }
            : {}),
          ...(actual === undefined ? {} : { actual })
        };
      }

      const remaining = expectation.timeoutMs - elapsed;
      try {
        await this.clock.sleep(
          Math.min(this.pollIntervalMs, remaining),
          signal
        );
      } catch (error) {
        if (isAborted(signal)) {
          return {
            status: "cancelled",
            type: expectation.type,
            durationMs: this.clock.now() - startedAt
          };
        }
        throw error;
      }
    }
  }
}
