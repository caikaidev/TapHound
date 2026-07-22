import { describe, expect, it } from "vitest";

import {
  ContextManifestSchema,
  InteractionPolicySchema,
  ProjectContextSchema
} from "../../src/domain/project-context.js";

const validManifest = {
  version: 1,
  files: [{
    path: "app/src/main/AndroidManifest.xml",
    sha256: "a".repeat(64)
  }]
};

const validPolicy = {
  allowedActions: ["click", "inputText", "back", "wait"],
  confirmationRequiredActions: ["back"],
  forbiddenActions: ["longClick", "swipe", "scrollTo"]
};

describe("generation project context contracts", () => {
  it("parses a strict context manifest and interaction policy", () => {
    expect(ContextManifestSchema.parse(validManifest)).toEqual(validManifest);
    expect(InteractionPolicySchema.parse(validPolicy)).toEqual(validPolicy);
  });

  it("parses a strict project context", () => {
    const context = {
      version: 1,
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      manifest: validManifest,
      interactionPolicy: validPolicy
    };

    expect(ProjectContextSchema.parse(context)).toEqual(context);
  });

  it("rejects unknown fields at every contract boundary", () => {
    expect(() => ContextManifestSchema.parse({
      ...validManifest,
      generatedAt: "2026-07-22T12:00:00.000Z"
    })).toThrow();
    expect(() => InteractionPolicySchema.parse({
      ...validPolicy,
      confidenceThreshold: 0.8
    })).toThrow();
    expect(() => ProjectContextSchema.parse({
      version: 1,
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      manifest: validManifest,
      interactionPolicy: validPolicy,
      projectRoot: "/tmp/app"
    })).toThrow();
  });

  it("rejects contradictory policy sets", () => {
    expect(() => InteractionPolicySchema.parse({
      ...validPolicy,
      forbiddenActions: ["back", "swipe"]
    })).toThrow(/both allowed and forbidden/i);
  });
});
