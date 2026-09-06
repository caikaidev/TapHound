import { describe, expect, it } from "vitest";

import {
  AnchorDefinitionSchema,
  KnowledgeBundleIndexSchema,
  ScreenDefinitionSchema,
  TransitionDefinitionSchema
} from "../../src/domain/knowledge.js";

describe("Knowledge schemas", () => {
  it("accepts the reduced deterministic Anchor surface", () => {
    expect(AnchorDefinitionSchema.parse({
      version: 1,
      id: "compose-button",
      status: "verified",
      roles: ["screenIdentity", "actionable"],
      identity: {
        kind: "element",
        locator: {
          resourceId: "com.example.app:id/compose",
          within: { resourceId: "com.example.app:id/mail-list" }
        }
      }
    }).identity.kind).toBe("element");
  });

  it("rejects overlapping Screen Anchor sets", () => {
    expect(() => ScreenDefinitionSchema.parse({
      version: 1,
      id: "mail-list",
      status: "observed",
      requiredAnchors: ["mail-list"],
      optionalAnchors: ["mail-list"],
      forbiddenAnchors: [],
      predicates: []
    })).toThrow(/disjoint/);
  });

  it("requires Transition verification to target the destination Screen", () => {
    expect(() => TransitionDefinitionSchema.parse({
      version: 1,
      id: "open-mail",
      status: "verified",
      fromScreen: "mail-list",
      toScreen: "mail-detail",
      semantic: "open-mail",
      action: { action: "click", anchorId: "mail-row" },
      verification: { targetScreen: "wrong-screen", timeoutMs: 5000 },
      observations: { attempts: 10, successes: 10, recoveryCost: 0 }
    })).toThrow(/toScreen/);
  });

  it("keeps canonical Knowledge references project-relative", () => {
    const index = KnowledgeBundleIndexSchema.parse({
      version: 1,
      packageName: "com.example.app",
      revision: 1,
      anchors: [{
        id: "home",
        path: ".taphound/knowledge/anchors/home.json",
        sha256: "a".repeat(64),
        status: "inferred"
      }],
      screens: [{
        id: "home",
        path: ".taphound/knowledge/screens/home.json",
        sha256: "b".repeat(64),
        status: "inferred"
      }],
      transitions: []
    });

    expect(index.revision).toBe(1);
  });
});
