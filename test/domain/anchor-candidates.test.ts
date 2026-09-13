import { describe, expect, it } from "vitest";

import {
  AnchorCandidateKindSchema,
  AnchorCandidateSchema,
  AnchorDefinitionSchema,
  AnchorIdentitySchema
} from "../../src/domain/knowledge.js";

describe("AnchorCandidateSchema", () => {
  it("accepts a semantic candidate chain entry", () => {
    const parsed = AnchorCandidateSchema.parse({
      kind: "composeSemantics",
      locator: { contentDescription: "Search" }
    });
    expect(parsed.kind).toBe("composeSemantics");
  });

  it("rejects visualMatch candidates in Core (fail closed)", () => {
    expect(AnchorCandidateSchema.safeParse({
      kind: "visualMatch",
      locator: { resourceId: "search" }
    }).success).toBe(false);
  });

  it("rejects unknown candidate kinds", () => {
    expect(AnchorCandidateSchema.safeParse({
      kind: "notARealKind",
      locator: { resourceId: "search" }
    }).success).toBe(false);
  });

  it("rejects duplicate candidate kinds in an anchor", () => {
    expect(AnchorDefinitionSchema.safeParse({
      version: 1,
      id: "search.open",
      status: "observed",
      roles: ["actionable"],
      identity: { kind: "element", locator: { resourceId: "search" } },
      candidates: [
        { kind: "resourceId", locator: { resourceId: "search" } },
        { kind: "resourceId", locator: { text: "Search" } }
      ]
    }).success).toBe(false);
  });

  it("keeps candidates optional for backward compatibility", () => {
    const parsed = AnchorDefinitionSchema.parse({
      version: 1,
      id: "search.open",
      status: "observed",
      roles: ["actionable"],
      identity: { kind: "element", locator: { resourceId: "search" } }
    });
    expect(parsed.candidates).toBeUndefined();
  });

  it("accepts a full ordered candidate chain", () => {
    const parsed = AnchorDefinitionSchema.parse({
      version: 1,
      id: "search.open",
      status: "observed",
      roles: ["actionable"],
      identity: { kind: "element", locator: { resourceId: "search" } },
      candidates: [
        { kind: "composeSemantics", locator: { text: "Search" } },
        { kind: "resourceId", locator: { resourceId: "search" } },
        { kind: "contentDescription", locator: { contentDescription: "Search" } },
        { kind: "visibleText", locator: { text: "Search" } }
      ]
    });
    expect(parsed.candidates?.length).toBe(4);
    const last = parsed.candidates?.at(-1);
    expect(AnchorCandidateKindSchema.parse(last?.kind)).toBe("visibleText");
    expect(AnchorIdentitySchema.parse(parsed.identity).kind).toBe("element");
  });
});