import type { FailureCode } from "../../domain/failure.js";
import type { Expectation } from "../../domain/journey.js";
import type {
  Locator
} from "../../domain/layout.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type { Clock } from "../../ports/clock.js";
import type {
  LogcatCollector,
  LogcatLine
} from "../collector/logcat-collector.js";
import { resolveLocator } from "../locator/locator-resolver.js";

export interface ExpectationContext {
  packageName: string;
  deviceSerial: string;
  stepStartedAt: number;
}

export type ExpectationResult =
  | {
      status: "passed";
      type: Expectation["type"];
      durationMs: number;
      actual?: string | undefined;
      matchedLine?: string | undefined;
    }
  | {
      status: "failed";
      type: Expectation["type"];
      code: Extract<
        FailureCode,
        | "EXPECT_ACTIVITY_FAILED"
        | "EXPECT_ELEMENT_FAILED"
        | "EXPECT_LOGCAT_FAILED"
      >;
      message: string;
      durationMs: number;
      actual?: string | undefined;
    }
  | {
      status: "cancelled";
      type: Expectation["type"];
      durationMs: number;
    };

function hasElement(
  elements: Parameters<typeof resolveLocator>[0],
  locator: Locator
): boolean {
  return resolveLocator(elements, locator, { requireEnabled: false }).status
    === "found";
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
  public constructor(
    private readonly adb: AdbPort,
    private readonly androidCli: AndroidCliPort,
    private readonly logcat: LogcatCollector,
    private readonly clock: Clock,
    private readonly pollIntervalMs = 100
  ) {}

  public async evaluate(
    expectation: Expectation,
    context: ExpectationContext,
    signal?: AbortSignal
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
        case "activity":
          actual = await this.adb.currentActivity({
            packageName: context.packageName,
            deviceSerial: context.deviceSerial,
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: commandTimeoutMs
          });
          if (actual === expectation.value) {
            return {
              status: "passed",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt,
              actual
            };
          }
          break;
        case "element":
          if (hasElement(await this.androidCli.layout({
            deviceSerial: context.deviceSerial,
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: commandTimeoutMs
          }), expectation.locator)) {
            return {
              status: "passed",
              type: expectation.type,
              durationMs: this.clock.now() - startedAt
            };
          }
          break;
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
            logcat: "EXPECT_LOGCAT_FAILED"
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
          logcat: "EXPECT_LOGCAT_FAILED"
        } as const;
        return {
          status: "failed",
          type: expectation.type,
          code: codes[expectation.type],
          message: `${expectation.type} Expect did not match before timeout`,
          durationMs: elapsed,
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
