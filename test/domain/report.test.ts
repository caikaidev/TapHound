import { describe, expect, it } from "vitest";

import {
  StepReportSchema,
  TapHoundReportSchema,
  hashJourney
} from "../../src/domain/report.js";
import { validReport } from "../fixtures/report.js";

describe("TapHoundReportSchema", () => {
  it("accepts the layered report contract", () => {
    expect(TapHoundReportSchema.parse(validReport())).toEqual(validReport());
  });

  it("reads a v4 report with per-device environment entries", () => {
    const current = validReport({
      environment: {
        devices: [
          {
            role: "default",
            deviceSerial: "emulator-5554",
            uiBackend: {
              id: "system-uiautomator",
              adapterVersion: "system-uiautomator-v1",
              configSha256: "a".repeat(64)
            }
          },
          {
            role: "peer",
            deviceSerial: "emulator-5556",
            uiBackend: {
              id: "android-cli",
              adapterVersion: "android-cli-v1",
              configSha256: "b".repeat(64)
            },
            uiCache: {
              hits: 1,
              misses: 2,
              stale: 0,
              relearns: 0,
              capturesSaved: 3,
              validationDurationMs: 12
            }
          }
        ],
        tools: { adb: "1" }
      }
    });
    expect(TapHoundReportSchema.parse(current)).toEqual(current);
  });

  it("rejects historical schema versions without a compatibility layer", () => {
    const legacy = { ...validReport(), schemaVersion: 3 as unknown as 4 };

    expect(() => TapHoundReportSchema.parse(legacy)).toThrow();
  });

  it("requires at least one device entry and unique roles", () => {
    const empty = validReport({
      environment: { devices: [], tools: {} }
    });
    expect(() => TapHoundReportSchema.parse(empty)).toThrow();

    const duplicated = validReport({
      environment: {
        devices: [
          { role: "default", deviceSerial: "emulator-5554" },
          { role: "default", deviceSerial: "emulator-5556" }
        ],
        tools: {}
      }
    });
    expect(() => TapHoundReportSchema.parse(duplicated)).toThrow();
  });

  it("records the device role on a step and validates its shape", () => {
    const report = validReport();
    const firstStep = report.steps[0];
    if (firstStep === undefined) {
      throw new Error("Fixture must contain a step");
    }

    expect(TapHoundReportSchema.parse(report).steps[0]?.device).toBe("default");

    const invalid = validReport({
      steps: [{ ...firstStep, device: "9bad-role" }]
    });
    expect(() => TapHoundReportSchema.parse(invalid)).toThrow();
  });

  it("requires per-device screenshot and logcat artifact arrays", () => {
    const report = validReport();
    Reflect.deleteProperty(report.artifacts, "logcats");

    expect(() => TapHoundReportSchema.parse(report)).toThrow();

    const badRolePath = validReport({
      artifacts: {
        ...validReport().artifacts,
        screenshots: [{ role: "peer", path: "screenshot-peer.png" }]
      }
    });
    expect(() => TapHoundReportSchema.parse(badRolePath)).toThrow(
      /unknown device role/i
    );
  });

  it("requires every result layer", () => {
    const report = validReport();
    Reflect.deleteProperty(report.layers, "collection");

    expect(() => TapHoundReportSchema.parse(report)).toThrow();
  });

  it("records the primary failure separately from secondary errors", () => {
    const report = validReport({
      status: "failed",
      layers: {
        run: "passed",
        structural: "failed",
        activityCheckpoint: "notRun",
        explicitExpect: "notRun",
        collection: "failed"
      },
      primaryFailure: {
        code: "LOCATOR_NOT_FOUND",
        message: "search button missing",
        phase: "replay",
        stepIndex: 0
      },
      secondaryErrors: [{
        code: "COLLECTION_FAILED",
        message: "screenshot failed",
        phase: "collection"
      }]
    });

    expect(TapHoundReportSchema.parse(report).primaryFailure?.code)
      .toBe("LOCATOR_NOT_FOUND");
  });

  it("records annotated-label fallback evidence", () => {
    const firstStep = validReport().steps[0];
    if (firstStep === undefined) {
      throw new Error("Fixture must contain a step");
    }
    const report = validReport({
      fallbackUsed: true,
      steps: [{
        ...firstStep,
        locator: {
          status: "found",
          fallbackUsed: true,
          fallbackLabel: "#7",
          annotatedScreenshotPath: "steps/001-fallback-annotated.png"
        }
      }]
    });

    expect(TapHoundReportSchema.parse(report).steps[0]?.locator)
      .toMatchObject({ fallbackUsed: true, fallbackLabel: "#7" });
  });

  it("records semantic anchor resolution confidence", () => {
    const firstStep = validReport().steps[0];
    if (firstStep === undefined) {
      throw new Error("Fixture must contain a step");
    }
    const report = validReport({
      steps: [{
        ...firstStep,
        locator: {
          status: "found",
          matchedBy: "anchor",
          anchorId: "search.open",
          fallbackUsed: false,
          anchor: {
            status: "resolved",
            resolvedBy: { kind: "visibleText", confidence: "fallback" }
          }
        }
      }]
    });

    const parsed = TapHoundReportSchema.parse(report);
    expect(parsed.steps[0]?.locator).toMatchObject({
      matchedBy: "anchor",
      anchorId: "search.open",
      anchor: {
        status: "resolved",
        resolvedBy: { kind: "visibleText", confidence: "fallback" }
      }
    });
  });
});

describe("hashJourney", () => {
  it("is stable across object key order", () => {
    expect(hashJourney({
      version: 1,
      name: "Search",
      steps: []
    })).toBe(hashJourney({
      steps: [],
      name: "Search",
      version: 1
    }));
  });

  it("changes when Journey content changes", () => {
    expect(hashJourney({ name: "one" })).not.toBe(hashJourney({ name: "two" }));
  });
});

describe("scrollTo step report", () => {
  it("accepts a scrollTo action with a scroll summary", () => {
    const parsed = StepReportSchema.parse({
      index: 0,
      action: "scrollTo",
      status: "passed",
      startedAtMs: 0,
      finishedAtMs: 10,
      durationMs: 10,
      scroll: { swipesUsed: 3, maxSwipes: 20 }
    });
    expect(parsed.scroll).toEqual({ swipesUsed: 3, maxSwipes: 20 });
  });
});
