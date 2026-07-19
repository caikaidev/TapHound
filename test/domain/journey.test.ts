import { describe, expect, it } from "vitest";

import { JourneySchema } from "../../src/domain/journey.js";
import searchJourney from "../fixtures/journeys/search.json" with { type: "json" };

const activity = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

describe("JourneySchema", () => {
  it("parses a valid APR Journey fixture", () => {
    const journey = JourneySchema.parse(searchJourney);

    expect(journey.name).toBe("Search");
    expect(journey.steps).toHaveLength(6);
  });

  it.each([
    {
      action: "click",
      locator: { resourceId: "toolbar_search" },
      activity
    },
    {
      action: "longClick",
      locator: { text: "Search" },
      durationMs: 800,
      activity
    },
    {
      action: "inputText",
      text: "hello world",
      activity
    },
    {
      action: "swipe",
      locator: { contentDescription: "Results" },
      direction: "up",
      distancePercent: 0.6,
      durationMs: 300,
      activity
    },
    {
      action: "back",
      activity
    },
    {
      action: "wait",
      activity
    }
  ])("accepts the $action Action", (step) => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Action",
      steps: [step]
    })).not.toThrow();
  });

  it.each([
    {
      type: "activity",
      value: "com.example.app.SearchActivity",
      timeoutMs: 3000
    },
    {
      type: "element",
      locator: { resourceId: "search_input" },
      timeoutMs: 3000
    },
    {
      type: "logcat",
      tag: "SearchViewModel",
      level: "D",
      pattern: "query=hello world",
      match: "literal",
      timeoutMs: 3000
    }
  ])("accepts the $type explicit Expect", (expectation) => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Expect",
      steps: [{
        action: "wait",
        activity,
        expect: expectation
      }]
    })).not.toThrow();
  });

  it("requires Activity before and after checkpoints", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Missing checkpoint",
      steps: [{
        action: "click",
        locator: { resourceId: "toolbar_search" }
      }]
    })).toThrow();
  });

  it.each(["click", "longClick"] as const)(
    "accepts an explicit annotated-label fallback for %s",
    (action) => {
      expect(() => JourneySchema.parse({
        version: 1,
        name: "Fallback",
        steps: [{
          action,
          locator: { resourceId: "toolbar_search" },
          fallback: {
            type: "annotatedLabel",
            label: "#7"
          },
          activity
        }]
      })).not.toThrow();
    }
  );

  it("rejects annotated-label fallback for unsupported Actions", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Invalid fallback",
      steps: [{
        action: "swipe",
        locator: { resourceId: "results" },
        direction: "up",
        fallback: {
          type: "annotatedLabel",
          label: "#7"
        },
        activity
      }]
    })).toThrow();
  });

  it("requires an Android CLI annotation label", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Invalid label",
      steps: [{
        action: "click",
        locator: { resourceId: "toolbar_search" },
        fallback: {
          type: "annotatedLabel",
          label: "search"
        },
        activity
      }]
    })).toThrow();
  });

  it("requires text for inputText", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Missing text",
      steps: [{ action: "inputText", activity }]
    })).toThrow();
  });

  it("requires a locator and direction for swipe", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Missing swipe data",
      steps: [{ action: "swipe", activity }]
    })).toThrow();
  });

  it("rejects an invalid regular-expression Logcat Expect", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Invalid regular expression",
      steps: [{
        action: "wait",
        activity,
        expect: {
          type: "logcat",
          tag: "SearchViewModel",
          pattern: "[",
          match: "regex",
          timeoutMs: 3000
        }
      }]
    })).toThrow(/regular expression/i);
  });

  it("rejects a natural-language official Journey shape", () => {
    expect(() => JourneySchema.parse({
      name: "Search",
      description: "Open search and enter hello world"
    })).toThrow();
  });

  it("requires at least one step", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Empty",
      steps: []
    })).toThrow();
  });

  it("rejects unsupported Journey versions", () => {
    expect(() => JourneySchema.parse({
      version: 2,
      name: "Future",
      steps: [{ action: "wait", activity }]
    })).toThrow();
  });
});
