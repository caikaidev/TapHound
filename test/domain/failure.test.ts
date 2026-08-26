import { describe, expect, it } from "vitest";

import {
  FAILURE_CODES,
  exitCodeForFailure,
  type TapHoundExitCode
} from "../../src/domain/failure.js";

describe("exitCodeForFailure", () => {
  it.each([
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
    "DEVICE_UNAVAILABLE",
    "APP_NOT_INSTALLED"
  ] as const)("maps %s to environment exit code 3", (failure) => {
    expect(exitCodeForFailure(failure)).toBe(3);
  });

  it("maps a TapHound fault to exit code 4", () => {
    const code: TapHoundExitCode = exitCodeForFailure("INTERNAL_ERROR");

    expect(code).toBe(4);
  });

  it("defines exactly the approved failure vocabulary", () => {
    expect(FAILURE_CODES).toHaveLength(37);
  });

  it.each([
    "EXTERNAL_PACKAGE_MISMATCH",
    "EXTERNAL_ACTIVITY_MISMATCH",
    "EXTERNAL_STEP_FAILED"
  ] as const)("maps %s to verification exit code 1", (failure) => {
    expect(exitCodeForFailure(failure)).toBe(1);
  });

  it.each([
    "EXTERNAL_FLOW_NOT_FOUND",
    "EXTERNAL_FLOW_STALE",
    "EXTERNAL_LOCATOR_STRICTNESS"
  ] as const)("maps %s to config exit code 2", (failure) => {
    expect(exitCodeForFailure(failure)).toBe(2);
  });

  it("maps ALIGN_* codes to exit code 2", () => {
    const codes = [
      "ALIGN_DEVICE_UNAVAILABLE",
      "ALIGN_CAMERA_INTENT_FAILED",
      "ALIGN_CAMERA_NOT_LAUNCHED",
      "ALIGN_SHUTTER_NOT_FOUND",
      "ALIGN_SHUTTER_AMBIGUOUS",
      "ALIGN_SHUTTER_NO_RESOURCE_ID",
      "ALIGN_CONFIRM_NOT_FOUND",
      "ALIGN_CONFIRM_AMBIGUOUS",
      "ALIGN_CONFIRM_NO_RESOURCE_ID",
      "ALIGN_FLOW_EXISTS"
    ] as const;
    for (const code of codes) {
      expect(exitCodeForFailure(code)).toBe(2);
    }
  });
});

describe("SCROLL_TARGET_NOT_FOUND", () => {
  it("is a known failure code with exit code 1", () => {
    expect(FAILURE_CODES).toContain("SCROLL_TARGET_NOT_FOUND");
    expect(exitCodeForFailure("SCROLL_TARGET_NOT_FOUND")).toBe(1);
  });
});
