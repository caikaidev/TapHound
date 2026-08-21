import { describe, expect, it } from "vitest";

import {
  RiskEvaluator
} from "../../../src/application/generation/risk-evaluator.js";
import type { InteractionPolicy } from "../../../src/domain/project-context.js";
import { RuntimeSnapshotSchema } from "../../../src/domain/runtime-snapshot.js";

function policy(
  overrides: Partial<InteractionPolicy> = {}
): InteractionPolicy {
  return {
    allowedActions: [],
    confirmationRequiredActions: [],
    forbiddenActions: [],
    ...overrides
  };
}

describe("RiskEvaluator", () => {
  const evaluator = new RiskEvaluator();

  it("gives the forbidden list precedence", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"],
      confirmationRequiredActions: ["click"],
      forbiddenActions: ["click"]
    }))).toEqual({ effectiveRisk: "forbidden" });
  });

  it("requires confirmation for explicitly configured actions", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"],
      confirmationRequiredActions: ["click"]
    }))).toEqual({ effectiveRisk: "confirmationRequired" });
  });

  it("allows only explicitly allowed actions without confirmation", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"]
    }))).toEqual({ effectiveRisk: "safe" });
  });

  it("defaults unknown or unlisted actions to confirmation", () => {
    expect(evaluator.evaluate("wait", policy())).toEqual({
      effectiveRisk: "confirmationRequired"
    });
  });

  it("requires confirmation for a semantically side-effecting click", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 1,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "forward",
        resourceId: "forward_message",
        text: "Forward",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }]
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "forward_message" },
      activity: { before: "com.example.app.MainActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({ allowedActions: ["click"] }), snapshot)).toEqual({
      effectiveRisk: "confirmationRequired",
      semanticSideEffect: {
        category: "externalCommit",
        matchedTerm: "forward"
      }
    });
  });

  it("does not classify search submission as an external commit", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 1,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.SearchActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "submit",
        resourceId: "submit_search",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }]
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "submit_search" },
      activity: { before: "com.example.app.SearchActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({ allowedActions: ["click"] }), snapshot)).toEqual({
      effectiveRisk: "safe"
    });
  });

  it("does not let search context suppress a destructive action", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 1,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.SearchActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "delete-history",
        resourceId: "delete_search_history",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }]
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "delete_search_history" },
      activity: { before: "com.example.app.SearchActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({ allowedActions: ["click"] }), snapshot)).toMatchObject({
      effectiveRisk: "confirmationRequired",
      semanticSideEffect: {
        category: "destructive",
        matchedTerm: "delete"
      }
    });
  });

  it("does not let search context suppress a send action", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 1,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.SearchActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "send-results",
        resourceId: "send_search_results",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }]
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "send_search_results" },
      activity: { before: "com.example.app.SearchActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({ allowedActions: ["click"] }), snapshot)).toMatchObject({
      effectiveRisk: "confirmationRequired",
      semanticSideEffect: {
        category: "externalCommit",
        matchedTerm: "send"
      }
    });
  });
});
