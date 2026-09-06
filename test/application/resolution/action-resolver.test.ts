import { describe, expect, it } from "vitest";

import { ActionResolver } from "../../../src/application/resolution/action-resolver.js";

const binding = {
  generationId: "generation-1",
  baseRevision: 1,
  snapshotHash: "a".repeat(64)
};

describe("ActionResolver", () => {
  it("converts a selected Transition into the existing ProposedStep", () => {
    const result = new ActionResolver().resolve({
      transition: {
        version: 1,
        id: "open-detail",
        status: "verified",
        fromScreen: "list",
        toScreen: "detail",
        semantic: "open-detail",
        action: { action: "click", anchorId: "first-row" },
        verification: { targetScreen: "detail", timeoutMs: 5000 },
        observations: { attempts: 4, successes: 4, recoveryCost: 0 }
      },
      anchors: [{
        version: 1,
        id: "first-row",
        status: "verified",
        roles: ["actionable"],
        identity: {
          kind: "element",
          locator: { resourceId: "com.example.app:id/row" }
        }
      }],
      screens: [{
        version: 1,
        id: "detail",
        status: "verified",
        requiredAnchors: ["first-row"],
        optionalAnchors: [],
        forbiddenAnchors: [],
        predicates: [{
          kind: "activityIs",
          activity: "com.example.app.DetailActivity"
        }]
      }],
      goal: {
        version: 1,
        id: "open-detail",
        targetScreen: "detail",
        parameters: {},
        limits: { maxSteps: 3, maxReplans: 1 }
      },
      binding,
      activity: "com.example.app.MainActivity"
    });

    expect(result).toMatchObject({
      status: "resolved",
      action: {
        transitionId: "open-detail",
        proposal: {
          action: "click",
          locator: { resourceId: "com.example.app:id/row" },
          expect: {
            type: "activity",
            value: "com.example.app.DetailActivity"
          }
        }
      }
    });
  });

  it("fails closed for an unresolved Goal parameter", () => {
    const result = new ActionResolver().resolve({
      transition: {
        version: 1,
        id: "enter-message",
        status: "verified",
        fromScreen: "editor",
        toScreen: "editor",
        semantic: "enter-message",
        action: { action: "inputText", parameter: "message" },
        verification: { targetScreen: "editor", timeoutMs: 5000 },
        observations: { attempts: 1, successes: 1, recoveryCost: 0 }
      },
      anchors: [],
      screens: [],
      goal: {
        version: 1,
        id: "compose",
        targetScreen: "editor",
        parameters: {},
        limits: { maxSteps: 3, maxReplans: 1 }
      },
      binding,
      activity: "com.example.app.MainActivity"
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "PARAMETER_MISSING" }
    });
  });
});
