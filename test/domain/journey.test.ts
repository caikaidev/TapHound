import { describe, expect, it } from "vitest";

import { JourneySchema, JourneyStepSchema } from "../../src/domain/journey.js";
import searchJourney from "../fixtures/journeys/search.json" with { type: "json" };

const activity = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

describe("JourneySchema", () => {
  it("parses a valid TapHound Journey fixture", () => {
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

  it("accepts ordinal and scoped Locators for scroll targets, containers, and expectations", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Repeated elements",
      steps: [{
        action: "scrollTo",
        locator: {
          text: "Item",
          index: 2,
          within: { resourceId: "results" }
        },
        container: {
          resourceId: "results",
          index: 0,
          within: { contentDescription: "Main panel" }
        },
        direction: "up",
        activity,
        expect: {
          type: "element",
          locator: { text: "Ready", index: 1 },
          timeoutMs: 3000
        }
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

describe("scrollTo step", () => {
  const activity = {
    before: "com.example.app.ChatActivity",
    after: "com.example.app.ChatActivity"
  };

  it("parses a scrollTo step and applies defaults", () => {
    const parsed = JourneyStepSchema.parse({
      action: "scrollTo",
      locator: { resourceId: "message_bubble", text: "hello" },
      container: { resourceId: "message_list" },
      direction: "up",
      activity
    });
    expect(parsed).toMatchObject({
      action: "scrollTo",
      maxSwipes: 20,
      distancePercent: 0.6,
      durationMs: 300
    });
  });

  it("rejects maxSwipes above 30", () => {
    expect(() => JourneyStepSchema.parse({
      action: "scrollTo",
      locator: { resourceId: "message_bubble" },
      container: { resourceId: "message_list" },
      direction: "up",
      maxSwipes: 31,
      activity
    })).toThrow();
  });

  it("rejects a scrollTo step without a container", () => {
    expect(() => JourneyStepSchema.parse({
      action: "scrollTo",
      locator: { resourceId: "message_bubble" },
      direction: "up",
      activity
    })).toThrow();
  });
});

describe("bridge step", () => {
  const activity = {
    before: "com.example.app.MainActivity",
    after: "com.example.app.MainActivity"
  };

  it("parses a valid bridge step and defaults replayMode to manual", () => {
    const parsed = JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera via button",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      activity
    });
    expect(parsed).toMatchObject({
      action: "bridge",
      scenario: "photoCapture",
      replayMode: "manual"
    });
  });

  it("accepts an explicit replayMode of manual", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "pickImage",
      description: "Pick image from gallery",
      triggerLocator: { text: "Gallery" },
      returnTimeoutMs: 30000,
      replayMode: "manual",
      activity
    })).not.toThrow();
  });

  it("rejects replayMode auto on a bridge step", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      replayMode: "auto",
      activity
    })).toThrow();
  });

  it("accepts an optional escapedPackageName", () => {
    const parsed = JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      escapedPackageName: "com.android.camera",
      returnTimeoutMs: 60000,
      activity
    });
    expect(parsed).toMatchObject({
      escapedPackageName: "com.android.camera"
    });
  });

  it("accepts an optional expect", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "pickFile",
      description: "Pick a file",
      triggerLocator: { resourceId: "attach_file" },
      returnTimeoutMs: 30000,
      activity,
      expect: {
        type: "activity",
        value: "com.example.app.MainActivity",
        timeoutMs: 5000
      }
    })).not.toThrow();
  });

  it.each([
    "photoCapture",
    "pickImage",
    "pickFile",
    "custom"
  ])("accepts the %s scenario", (scenario) => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario,
      description: "Bridge action",
      triggerLocator: { resourceId: "trigger" },
      returnTimeoutMs: 30000,
      activity
    })).not.toThrow();
  });

  it("rejects an invalid scenario", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "videoCapture",
      description: "Trigger video",
      triggerLocator: { resourceId: "video_button" },
      returnTimeoutMs: 60000,
      activity
    })).toThrow();
  });

  it("requires a description", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      activity
    })).toThrow();
  });

  it("requires a triggerLocator", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      returnTimeoutMs: 60000,
      activity
    })).toThrow();
  });

  it("requires a positive returnTimeoutMs", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 0,
      activity
    })).toThrow();
  });
});
