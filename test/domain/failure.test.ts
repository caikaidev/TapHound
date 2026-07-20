import { describe, expect, it } from "vitest";

import {
  FAILURE_CODES,
  exitCodeForFailure,
  type TapHoundExitCode
} from "../../src/domain/failure.js";

describe("exitCodeForFailure", () => {
  it.each([
    "BUILD_FAILED",
    "APP_LAUNCH_FAILED",
    "APP_CRASHED",
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "ACTION_FAILED",
    "IDLE_TIMEOUT",
    "ACTIVITY_BEFORE_MISMATCH",
    "ACTIVITY_AFTER_MISMATCH",
    "EXPECT_ACTIVITY_FAILED",
    "EXPECT_ELEMENT_FAILED",
    "EXPECT_LOGCAT_FAILED",
    "COLLECTION_FAILED"
  ] as const)("maps %s to verification exit code 1", (failure) => {
    expect(exitCodeForFailure(failure)).toBe(1);
  });

  it("maps invalid input to exit code 2", () => {
    expect(exitCodeForFailure("CONFIG_INVALID")).toBe(2);
  });

  it.each([
    "ENVIRONMENT_MISSING_TOOL",
    "DEVICE_UNAVAILABLE"
  ] as const)("maps %s to environment exit code 3", (failure) => {
    expect(exitCodeForFailure(failure)).toBe(3);
  });

  it("maps a TapHound fault to exit code 4", () => {
    const code: TapHoundExitCode = exitCodeForFailure("INTERNAL_ERROR");

    expect(code).toBe(4);
  });

  it("defines exactly the approved failure vocabulary", () => {
    expect(FAILURE_CODES).toHaveLength(17);
  });
});
