import { describe, expect, it } from "vitest";

import {
  ContextManifestSchema,
  InteractionPolicySchema,
  ProjectContextModuleSchema,
  ProjectContextSchema
} from "../../src/domain/project-context.js";
import {
  projectContextIndex,
  projectContextModule
} from "../fixtures/project-context.js";

const validManifest = {
  version: 1,
  files: [{
    path: "app/src/main/AndroidManifest.xml",
    sha256: "a".repeat(64),
    confidence: "sourceConfirmed"
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

  it.each([
    "sourceConfirmed",
    "runtimeConfirmed",
    "inferred",
    "unknown"
  ])("accepts the exact evidence confidence member %s", (confidence) => {
    expect(ContextManifestSchema.parse({
      ...validManifest,
      files: [{ ...validManifest.files[0], confidence }]
    }).files[0]?.confidence).toBe(confidence);
  });

  it.each([
    "confirmed",
    "high",
    "",
    0.9,
    null
  ])("rejects out-of-contract evidence confidence %s", (confidence) => {
    expect(() => ContextManifestSchema.parse({
      ...validManifest,
      files: [{ ...validManifest.files[0], confidence }]
    })).toThrow();
  });

  it("parses a strict project context", () => {
    expect(ProjectContextSchema.parse(projectContextIndex))
      .toEqual(projectContextIndex);
    expect(ProjectContextModuleSchema.parse(projectContextModule))
      .toEqual(projectContextModule);
  });

  it("requires an application module in the v2 index", () => {
    expect(() => ProjectContextSchema.parse({
      ...projectContextIndex,
      modules: projectContextIndex.modules.map((module) => ({
        ...module,
        kind: "feature"
      }))
    })).toThrow(/application module/i);
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
      ...projectContextIndex,
      projectRoot: "/tmp/app"
    })).toThrow();
  });

  it.each([
    String.raw`C:\outside.txt`,
    String.raw`\\server\share\outside.txt`,
    String.raw`..\outside.txt`,
    String.raw`safe/..\outside.txt`
  ])("rejects platform-specific context path escape %s", (path) => {
    expect(() => ContextManifestSchema.parse({
      version: 1,
      files: [{
        path,
        sha256: "a".repeat(64),
        confidence: "sourceConfirmed"
      }]
    })).toThrow(/within the project/i);
  });

  it("normalizes safe context path separators", () => {
    expect(ContextManifestSchema.parse({
      version: 1,
      files: [{
        path: String.raw`app\src\main\AndroidManifest.xml`,
        sha256: "a".repeat(64),
        confidence: "sourceConfirmed"
      }]
    }).files[0]?.path).toBe("app/src/main/AndroidManifest.xml");
  });

  it("rejects contradictory policy sets", () => {
    expect(() => InteractionPolicySchema.parse({
      ...validPolicy,
      forbiddenActions: ["back", "swipe"]
    })).toThrow(/both allowed and forbidden/i);
  });
});
