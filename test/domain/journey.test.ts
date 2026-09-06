import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEVICE_ROLE,
  JourneySchema,
  JourneyStepSchema
} from "../../src/domain/journey.js";
import searchJourney from "../fixtures/journeys/search.json" with { type: "json" };

const activity = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

const singleDevice = [{ role: DEFAULT_DEVICE_ROLE }];

function journey(steps: unknown[], devices: unknown = singleDevice): {
  version: number;
  name: string;
  devices: unknown;
  steps: unknown[];
} {
  return { version: 2, name: "Journey", devices, steps };
}

describe("JourneySchema", () => {
  it("parses a valid TapHound Journey fixture", () => {
    const parsed = JourneySchema.parse(searchJourney);

    expect(parsed.name).toBe("Search");
    expect(parsed.steps).toHaveLength(6);
    expect(parsed.version).toBe(2);
    expect(parsed.devices).toEqual([{ role: DEFAULT_DEVICE_ROLE }]);
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
    expect(() => JourneySchema.parse(journey([step]))).not.toThrow();
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
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      activity,
      expect: expectation
    }]))).not.toThrow();
  });

  it("accepts ordinal and scoped Locators for scroll targets, containers, and expectations", () => {
    expect(() => JourneySchema.parse(journey([{
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
    }]))).not.toThrow();
  });

  it("requires Activity before and after checkpoints", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "click",
      locator: { resourceId: "toolbar_search" }
    }]))).toThrow();
  });

  it.each(["click", "longClick"] as const)(
    "accepts an explicit annotated-label fallback for %s",
    (action) => {
      expect(() => JourneySchema.parse(journey([{
        action,
        locator: { resourceId: "toolbar_search" },
        fallback: {
          type: "annotatedLabel",
          label: "#7"
        },
        activity
      }]))).not.toThrow();
    }
  );

  it("rejects annotated-label fallback for unsupported Actions", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "swipe",
      locator: { resourceId: "results" },
      direction: "up",
      fallback: {
        type: "annotatedLabel",
        label: "#7"
      },
      activity
    }]))).toThrow();
  });

  it("requires an Android CLI annotation label", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "click",
      locator: { resourceId: "toolbar_search" },
      fallback: {
        type: "annotatedLabel",
        label: "search"
      },
      activity
    }]))).toThrow();
  });

  it("requires text for inputText", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "inputText",
      activity
    }]))).toThrow();
  });

  it("requires a locator and direction for swipe", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "swipe",
      activity
    }]))).toThrow();
  });

  it("rejects an invalid regular-expression Logcat Expect", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      activity,
      expect: {
        type: "logcat",
        tag: "SearchViewModel",
        pattern: "[",
        match: "regex",
        timeoutMs: 3000
      }
    }]))).toThrow(/regular expression/i);
  });

  it("rejects a natural-language official Journey shape", () => {
    expect(() => JourneySchema.parse({
      name: "Search",
      description: "Open search and enter hello world"
    })).toThrow();
  });

  it("requires at least one step", () => {
    expect(() => JourneySchema.parse(journey([]))).toThrow();
  });

  it("requires a non-empty devices declaration", () => {
    expect(() => JourneySchema.parse({
      version: 2,
      name: "No devices",
      devices: [],
      steps: [{ action: "wait", activity }]
    })).toThrow();
  });

  it("rejects unsupported Journey versions", () => {
    expect(() => JourneySchema.parse({
      version: 1,
      name: "Legacy",
      devices: singleDevice,
      steps: [{ action: "wait", activity }]
    })).toThrow();
    expect(() => JourneySchema.parse({
      version: 3,
      name: "Future",
      devices: singleDevice,
      steps: [{ action: "wait", activity }]
    })).toThrow();
  });
});

describe("Journey device declaration", () => {
  const senderStep = {
    action: "click",
    device: "sender",
    locator: { resourceId: "send_button" },
    activity
  };
  const receiverStep = {
    action: "click",
    device: "receiver",
    locator: { resourceId: "conversation_item" },
    activity
  };

  it("accepts a multi-device Journey with fully bound steps", () => {
    const parsed = JourneySchema.parse(journey(
      [senderStep, receiverStep],
      [{ role: "sender" }, { role: "receiver" }]
    ));
    expect(parsed.devices).toEqual([{ role: "sender" }, { role: "receiver" }]);
  });

  it("accepts an optional description per device", () => {
    expect(() => JourneySchema.parse(journey(
      [{ ...senderStep, device: "sender" }],
      [{ role: "sender", description: "Account A" }]
    ))).not.toThrow();
  });

  it("rejects duplicate device roles", () => {
    expect(() => JourneySchema.parse(journey(
      [{ ...senderStep }],
      [{ role: "sender" }, { role: "sender" }]
    ))).toThrow(/unique/i);
  });

  it("requires every step to declare its device on a multi-device Journey", () => {
    expect(() => JourneySchema.parse(journey(
      [senderStep, { action: "wait", activity }],
      [{ role: "sender" }, { role: "receiver" }]
    ))).toThrow(/declare its device/i);
  });

  it("rejects a step that references an undeclared device role", () => {
    expect(() => JourneySchema.parse(journey(
      [senderStep, receiverStep, {
        action: "wait",
        device: "ghost",
        activity
      }],
      [{ role: "sender" }, { role: "receiver" }]
    ))).toThrow(/undeclared device role/i);
  });

  it("rejects a declared role that no step uses", () => {
    expect(() => JourneySchema.parse(journey(
      [senderStep, receiverStep],
      [{ role: "sender" }, { role: "receiver" }, { role: "observer" }]
    ))).toThrow(/never used/i);
  });

  it("allows omitting device on a single-device Journey", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      activity
    }]))).not.toThrow();
  });

  it("allows an explicit device matching the single declared role", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      device: DEFAULT_DEVICE_ROLE,
      activity
    }]))).not.toThrow();
  });

  it("rejects a role that does not match the single declared role", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      device: "sender",
      activity
    }]))).toThrow(/undeclared device role/i);
  });

  it("rejects malformed device roles", () => {
    expect(() => JourneySchema.parse(journey(
      [senderStep],
      [{ role: "Sender" }]
    ))).toThrow(/role/i);
    expect(() => JourneySchema.parse(journey(
      [{ ...senderStep, device: "2nd" }],
      [{ role: "2nd" }]
    ))).toThrow();
  });
});

describe("wait until step", () => {
  it("accepts wait with until and timeoutMs together", () => {
    const parsed = JourneySchema.parse(journey([{
      action: "wait",
      until: { element: { resourceId: "conversation_item_new" } },
      timeoutMs: 15000,
      activity
    }]));
    expect(parsed.steps[0]).toMatchObject({
      action: "wait",
      until: { element: { resourceId: "conversation_item_new" } },
      timeoutMs: 15000
    });
  });

  it("accepts a plain wait without until or timeoutMs", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      activity
    }]))).not.toThrow();
  });

  it("rejects until without timeoutMs", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      until: { element: { resourceId: "conversation_item_new" } },
      activity
    }]))).toThrow(/together/i);
  });

  it("rejects timeoutMs without until", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      timeoutMs: 5000,
      activity
    }]))).toThrow(/together/i);
  });

  it("requires a Locator inside until", () => {
    expect(() => JourneySchema.parse(journey([{
      action: "wait",
      until: {},
      timeoutMs: 5000,
      activity
    }]))).toThrow();
  });

  it("keeps the step-level schema standalone", () => {
    expect(() => JourneyStepSchema.parse({
      action: "wait",
      until: { element: { resourceId: "ready" } },
      timeoutMs: 1000,
      activity
    })).not.toThrow();
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

  it("rejects replayMode auto without flow or externalSteps", () => {
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

  it("accepts replayMode auto with a named flow", () => {
    const parsed = JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      escapedPackageName: "com.android.camera",
      returnTimeoutMs: 60000,
      flow: "camera/photo-capture",
      replayMode: "auto",
      activity
    });
    expect(parsed).toMatchObject({
      replayMode: "auto",
      flow: "camera/photo-capture"
    });
  });

  it("accepts replayMode auto with inline externalSteps", () => {
    const parsed = JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      escapedPackageName: "com.android.camera",
      returnTimeoutMs: 60000,
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter_button" },
        expectedActivity: "com.android.camera.CameraActivity"
      }],
      replayMode: "auto",
      activity
    });
    expect(parsed).toMatchObject({
      replayMode: "auto",
      externalSteps: [{ action: "click" }]
    });
  });

  it("rejects flow and externalSteps together", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      escapedPackageName: "com.android.camera",
      returnTimeoutMs: 60000,
      flow: "camera/photo-capture",
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter_button" },
        expectedActivity: "com.android.camera.CameraActivity"
      }],
      activity
    })).toThrow(/mutually exclusive/i);
  });

  it("requires escapedPackageName when flow is present", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      flow: "camera/photo-capture",
      activity
    })).toThrow(/escapedPackageName/i);
  });

  it("requires escapedPackageName when externalSteps are present", () => {
    expect(() => JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      externalSteps: [{
        action: "click",
        locator: { resourceId: "shutter_button" },
        expectedActivity: "com.android.camera.CameraActivity"
      }],
      activity
    })).toThrow(/escapedPackageName/i);
  });

  it("accepts an optional escapeTimeoutMs", () => {
    const parsed = JourneyStepSchema.parse({
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      escapeTimeoutMs: 5000,
      activity
    });
    expect(parsed).toMatchObject({
      escapeTimeoutMs: 5000
    });
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
