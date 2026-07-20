import { describe, expect, it } from "vitest";

import {
  TapHoundReportSchema,
  hashJourney
} from "../../src/domain/report.js";
import { validReport } from "../fixtures/report.js";

describe("TapHoundReportSchema", () => {
  it("accepts the layered v1 report contract", () => {
    expect(TapHoundReportSchema.parse(validReport())).toEqual(validReport());
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
        build: "passed",
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
