import { describe, expect, it } from "vitest";

import { ProposedStepSchema } from "../../src/domain/proposed-step.js";

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
  ])("rejects coordinates, v2 locators, and annotated fallback", (shape) => {
    expect(() => ProposedStepSchema.parse({
      binding,
      ...shape,
      activity: { before: "com.example.app.MainActivity" }
    })).toThrow();
  });

  it("rejects a v2 expectation and unknown planner metadata", () => {
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
});
