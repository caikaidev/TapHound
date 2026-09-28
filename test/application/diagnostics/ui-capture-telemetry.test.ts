import { describe, expect, it } from "vitest";

import {
  classifyCaptureFailure,
  UiCaptureTelemetry
} from "../../../src/application/diagnostics/ui-capture-telemetry.js";

describe("classifyCaptureFailure", () => {
  it.each([
    ["an abort timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
    ["a wrapped timeout cause", new Error("capture failed", {
      cause: new DOMException("aborted", "TimeoutError")
    }), "timeout"],
    ["a timed-out message", new Error("UIAutomator dump timed out after 5000ms"), "timeout"],
    ["a cancellation", new DOMException("aborted", "AbortError"), "cancelled"],
    ["an HTTP 404", Object.assign(new Error("Appium HTTP 404"), { status: 404 }), "http4xx"],
    ["an HTTP 500", Object.assign(new Error("Appium HTTP 500"), { status: 500 }), "http5xx"],
    ["anything else", new Error("socket hang up"), "error"],
    ["a non-error", "boom", "error"]
  ] as const)("classifies %s", (_label, error, kind) => {
    expect(classifyCaptureFailure(error)).toBe(kind);
  });
});

describe("UiCaptureTelemetry", () => {
  it("aggregates captures, latency buckets, failures, and recoveries per backend", () => {
    const telemetry = new UiCaptureTelemetry();
    telemetry.captured("appium-uiautomator2", 120);
    telemetry.captured("appium-uiautomator2", 1300.4);
    telemetry.captured("appium-uiautomator2", 5000.6, new DOMException("t", "TimeoutError"));
    telemetry.sessionRecovered("appium-uiautomator2", true);
    telemetry.sessionRecovered("appium-uiautomator2", false);
    telemetry.captured("system-uiautomator", 2400);

    expect(telemetry.summary()).toEqual([
      {
        backend: "appium-uiautomator2",
        captures: 3,
        failures: { timeout: 1, cancelled: 0, http4xx: 0, http5xx: 0, error: 0 },
        totalMs: 6421,
        maxMs: 5001,
        latencyBuckets: [1, 0, 0, 1, 0, 1],
        sessionRecoveries: 1,
        sessionRecoveryFailures: 1
      },
      {
        backend: "system-uiautomator",
        captures: 1,
        failures: { timeout: 0, cancelled: 0, http4xx: 0, http5xx: 0, error: 0 },
        totalMs: 2400,
        maxMs: 2400,
        latencyBuckets: [0, 0, 0, 0, 1, 0],
        sessionRecoveries: 0,
        sessionRecoveryFailures: 0
      }
    ]);
  });
});
