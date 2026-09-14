import { describe, expect, it } from "vitest";

import {
  JourneyLifecycleStateSchema,
  type JourneyLifecycleState
} from "../../src/domain/journey-lifecycle.js";

describe("journey lifecycle", () => {
  it("accepts the six documented states", () => {
    for (const state of [
      "draft",
      "verified",
      "promoted",
      "suspect",
      "stale",
      "retired"
    ]) {
      expect(JourneyLifecycleStateSchema.parse(state)).toBe(state);
    }
  });

  it("rejects unknown states", () => {
    expect(() => JourneyLifecycleStateSchema.parse("deprecated")).toThrow();
  });

  it("is an exhaustive six-state set", () => {
    const states = new Set<JourneyLifecycleState>([
      "draft",
      "verified",
      "promoted",
      "suspect",
      "stale",
      "retired"
    ]);
    expect(states.size).toBe(6);
  });
});