import { describe, expect, it } from "vitest";

import {
  RiskEvaluator
} from "../../../src/application/generation/risk-evaluator.js";
import type { InteractionPolicy } from "../../../src/domain/project-context.js";
import { RuntimeSnapshotSchema } from "../../../src/domain/runtime-snapshot.js";
import { TEST_SNAPSHOT_UI } from "../../fakes/ui-backend.js";

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
    }))).toEqual({
      effectiveRisk: "confirmationRequired",
      reason: {
        rule: "policyActionRequiresConfirmation",
        message: "click is listed in confirmationRequiredActions"
      }
    });
  });

  it("allows only explicitly allowed actions without confirmation", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"]
    }))).toEqual({ effectiveRisk: "safe" });
  });

  it("defaults unknown or unlisted actions to confirmation", () => {
    expect(evaluator.evaluate("wait", policy())).toEqual({
      effectiveRisk: "confirmationRequired",
      reason: {
        rule: "actionNotAllowlisted",
        message: "wait is not listed in allowedActions"
      }
    });
  });

  it("requires confirmation for a semantically hard-committing click", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 2,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "send",
        resourceId: "send_message",
        text: "Send",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }],
      ...TEST_SNAPSHOT_UI
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "send_message" },
      activity: { before: "com.example.app.MainActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({ allowedActions: ["click"] }), snapshot)).toEqual({
      effectiveRisk: "confirmationRequired",
      reason: {
        rule: "semanticSideEffect",
        category: "hardCommit",
        matchedTerm: "send",
        message: "click targets a hardCommit control (matched term \"send\")"
      }
    });
  });

  it("treats soft-commit keywords as safe by default", () => {
    const softCommitCases = [
      { resourceId: "forward_message", text: "Forward" },
      { resourceId: "create_group_btn", text: "Create a new group" },
      { resourceId: "save_draft", text: "Save Draft" },
      { resourceId: "share_link", text: "Share" },
      { resourceId: "post_update", text: "Post" },
      { resourceId: "invite_user", text: "Invite" }
    ];

    for (const locator of softCommitCases) {
      const snapshot = RuntimeSnapshotSchema.parse({
        version: 2,
        generationId: "generation-1",
        baseRevision: 1,
        deviceSerial: "emulator-5554",
        expectedPackageName: "com.example.app",
        foregroundPackageName: "com.example.app",
        activity: "com.example.app.MainActivity",
        pid: 42,
        capturedAt: "2026-07-23T00:00:00.000Z",
        layout: [{
          id: "el",
          resourceId: locator.resourceId,
          text: locator.text,
          clickable: true,
          enabled: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          children: []
        }],
        ...TEST_SNAPSHOT_UI
      });

      const result = evaluator.evaluate({
        action: "click",
        locator: { resourceId: locator.resourceId },
        activity: { before: "com.example.app.MainActivity" },
        binding: {
          generationId: "generation-1",
          baseRevision: 1,
          snapshotHash: "a".repeat(64)
        }
      }, policy({ allowedActions: ["click"] }), snapshot);

      expect(result).toEqual({ effectiveRisk: "safe" });
    }
  });

  it("still confirms soft-commit actions when policy requires the action", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 2,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 42,
      capturedAt: "2026-07-23T00:00:00.000Z",
      layout: [{
        id: "create",
        resourceId: "create_group_btn",
        text: "Create a new group",
        clickable: true,
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      }],
      ...TEST_SNAPSHOT_UI
    });

    expect(evaluator.evaluate({
      action: "click",
      locator: { resourceId: "create_group_btn" },
      activity: { before: "com.example.app.MainActivity" },
      binding: {
        generationId: "generation-1",
        baseRevision: 1,
        snapshotHash: "a".repeat(64)
      }
    }, policy({
      allowedActions: ["click"],
      confirmationRequiredActions: ["click"]
    }), snapshot)).toEqual({
      effectiveRisk: "confirmationRequired",
      reason: {
        rule: "policyActionRequiresConfirmation",
        message: "click is listed in confirmationRequiredActions"
      }
    });
  });

  it("does not classify search submission as an external commit", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 2,
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
      }],
      ...TEST_SNAPSHOT_UI
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
      version: 2,
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
      }],
      ...TEST_SNAPSHOT_UI
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
      reason: {
        rule: "semanticSideEffect",
        category: "destructive",
        matchedTerm: "delete",
        message: "click targets a destructive control (matched term \"delete\")"
      }
    });
  });

  it("does not let search context suppress a send action", () => {
    const snapshot = RuntimeSnapshotSchema.parse({
      version: 2,
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
      }],
      ...TEST_SNAPSHOT_UI
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
      reason: {
        rule: "semanticSideEffect",
        category: "hardCommit",
        matchedTerm: "send",
        message: "click targets a hardCommit control (matched term \"send\")"
      }
    });
  });
});
