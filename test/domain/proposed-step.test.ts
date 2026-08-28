import { describe, expect, it } from "vitest";

import {
  ProposedStepSchema,
  hashProposedStep
} from "../../src/domain/proposed-step.js";

const binding = {
  generationId: "generation-1",
  baseRevision: 1,
  snapshotHash: "b".repeat(64)
};

describe("ProposedStepSchema", () => {
  it.each([
    {
      binding,
      action: "click",
      locator: { resourceId: "search" },
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "longClick",
      locator: { text: "Search" },
      durationMs: 800,
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "inputText",
      text: "hello",
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "swipe",
      locator: { contentDescription: "Results" },
      direction: "up",
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "scrollTo",
      locator: { text: "Result" },
      container: { resourceId: "results" },
      direction: "up",
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "back",
      activity: { before: "com.example.app.MainActivity" }
    },
    {
      binding,
      action: "wait",
      activity: { before: "com.example.app.MainActivity" },
      expect: {
        type: "element",
        locator: { resourceId: "ready" },
        timeoutMs: 3000
      }
    }
  ])("accepts the Journey v1 $action proposal shape", (step) => {
    expect(() => ProposedStepSchema.parse(step)).not.toThrow();
  });

  it("accepts ordinal and scoped Locators across proposal surfaces", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "scrollTo",
      locator: {
        text: "Item",
        index: 2,
        within: { resourceId: "results" }
      },
      container: { resourceId: "results", index: 0 },
      direction: "up",
      activity: { before: "com.example.app.MainActivity" },
      expect: {
        type: "element",
        locator: { text: "Ready", index: 1 },
        timeoutMs: 3000
      }
    })).not.toThrow();
  });

  it("requires an exact proposal snapshot binding", () => {
    expect(() => ProposedStepSchema.parse({
      action: "wait",
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
    expect(() => ProposedStepSchema.parse({
      binding: { ...binding, plannerRevision: 1 },
      action: "wait",
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("rejects an authoritative after-activity checkpoint", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "wait",
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.SearchActivity"
      }
    })).toThrow();
  });

  it.each([
    { action: "click", x: 10, y: 20 },
    { action: "click", locator: { testTag: "search" } },
    {
      action: "click",
      locator: { resourceId: "search" },
      fallback: { type: "annotatedLabel", label: "#1" }
    }
  ])("rejects coordinates, unknown locator keys, and annotated fallback", (shape) => {
    expect(() => ProposedStepSchema.parse({
      binding,
      ...shape,
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("rejects a visual expectation and unknown planner metadata", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "wait",
      activity: { before: "com.example.app.MainActivity" },
      expect: {
        type: "visual",
        prompt: "search screen is visible",
        timeoutMs: 3000
      }
    })).toThrow();
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "wait",
      activity: { before: "com.example.app.MainActivity" },
      confidence: 0.99,
      risk: "safe"
    })).toThrow();
  });

  it("hashes the canonical parsed proposal rather than object key order", () => {
    const first = {
      binding,
      action: "click",
      locator: { resourceId: "search", text: "Search" },
      activity: { before: "com.example.app.MainActivity" }
    };
    const reordered = {
      activity: { before: "com.example.app.MainActivity" },
      locator: { text: "Search", resourceId: "search" },
      action: "click",
      binding
    };
    expect(hashProposedStep(first)).toBe(hashProposedStep(reordered));
    expect(hashProposedStep({
      ...first,
      locator: { resourceId: "other" }
    })).not.toBe(hashProposedStep(first));
  });

  it("accepts a bridge proposal with scenario, triggerLocator, and returnTimeoutMs", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      activity: { before: "com.example.app.MainActivity" }
    })).not.toThrow();
  });

  it("accepts a bridge proposal with a named flow", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      flow: "camera/photo-capture",
      activity: { before: "com.example.app.MainActivity" }
    })).not.toThrow();
  });

  it("accepts a bridge proposal with escapeTimeoutMs", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      escapeTimeoutMs: 5000,
      activity: { before: "com.example.app.MainActivity" }
    })).not.toThrow();
  });

  it("rejects externalSteps in a bridge proposal", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
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
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("rejects escapedPackageName in a bridge proposal", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      escapedPackageName: "com.android.camera",
      returnTimeoutMs: 60000,
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("rejects replayMode in a bridge proposal", () => {
    expect(() => ProposedStepSchema.parse({
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      replayMode: "manual",
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("hashes a bridge proposal deterministically regardless of key order", () => {
    const first = {
      binding,
      action: "bridge",
      scenario: "photoCapture",
      description: "Trigger camera",
      triggerLocator: { resourceId: "camera_button" },
      returnTimeoutMs: 60000,
      activity: { before: "com.example.app.MainActivity" }
    };
    const reordered = {
      activity: { before: "com.example.app.MainActivity" },
      returnTimeoutMs: 60000,
      triggerLocator: { resourceId: "camera_button" },
      description: "Trigger camera",
      scenario: "photoCapture",
      action: "bridge",
      binding
    };
    expect(hashProposedStep(first)).toBe(hashProposedStep(reordered));
  });
});
