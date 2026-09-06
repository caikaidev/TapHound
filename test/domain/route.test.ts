import { describe, expect, it } from "vitest";

import { RoutePlanSchema } from "../../src/domain/route.js";

describe("RoutePlanSchema", () => {
  it("accepts a contiguous Route IR", () => {
    expect(RoutePlanSchema.parse({
      version: 1,
      goalId: "reply-mail",
      knowledgeHash: "a".repeat(64),
      startScreen: "mail-list",
      targetScreen: "reply-editor",
      segments: [
        {
          index: 0,
          transitionId: "open-mail",
          fromScreen: "mail-list",
          toScreen: "mail-detail",
          cost: 1
        },
        {
          index: 1,
          transitionId: "reply",
          fromScreen: "mail-detail",
          toScreen: "reply-editor",
          cost: 1
        }
      ],
      totalCost: 2,
      plannedAt: "2026-09-06T00:00:00.000Z"
    }).segments).toHaveLength(2);
  });

  it("rejects disconnected or mispriced Routes", () => {
    expect(() => RoutePlanSchema.parse({
      version: 1,
      goalId: "reply-mail",
      knowledgeHash: "a".repeat(64),
      startScreen: "mail-list",
      targetScreen: "reply-editor",
      segments: [{
        index: 0,
        transitionId: "reply",
        fromScreen: "mail-detail",
        toScreen: "reply-editor",
        cost: 1
      }],
      totalCost: 2,
      plannedAt: "2026-09-06T00:00:00.000Z"
    })).toThrow();
  });
});
