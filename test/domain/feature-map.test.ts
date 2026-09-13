import { describe, expect, it } from "vitest";

import {
  FeatureMapProjectionSchema,
  type FeatureMapProjection
} from "../../src/domain/feature-map.js";

const validProjection: FeatureMapProjection = {
  version: 1,
  packageName: "com.example.app",
  knowledgeHash: "a".repeat(64),
  revision: 3,
  entryScreens: [{
    id: "inbox",
    status: "verified",
    feature: "inbox"
  }],
  features: [{
    id: "inbox",
    screens: ["inbox", "mail_detail"],
    transitions: ["inbox.open_mail"],
    anchors: ["inbox.first_mail"]
  }],
  transitions: [{
    id: "inbox.open_mail",
    status: "observed",
    fromScreen: "inbox",
    toScreen: "mail_detail",
    action: "click(anchor=inbox.first_mail)",
    observations: {
      attempts: 5,
      successes: 4,
      recoveryCost: 2.5
    }
  }],
  anchors: [{
    id: "inbox.first_mail",
    status: "verified",
    roles: ["actionable"]
  }]
};

describe("FeatureMapProjectionSchema", () => {
  it("accepts a canonical projection", () => {
    const parsed = FeatureMapProjectionSchema.parse(validProjection);
    expect(parsed.version).toBe(1);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.entryScreens[0]?.id).toBe("inbox");
  });

  it("defaults feature transition/anchor lists to empty", () => {
    const parsed = FeatureMapProjectionSchema.parse({
      ...validProjection,
      features: [{ id: "inbox", screens: ["inbox"] }]
    });
    expect(parsed.features[0]?.transitions).toEqual([]);
    expect(parsed.features[0]?.anchors).toEqual([]);
  });

  it("rejects unknown fields", () => {
    expect(FeatureMapProjectionSchema.safeParse({
      ...validProjection,
      extra: true
    }).success).toBe(false);
  });

  it("rejects a missing entry screen list", () => {
    expect(FeatureMapProjectionSchema.safeParse({
      ...validProjection,
      entryScreens: []
    }).success).toBe(false);
  });

  it("rejects an empty features list", () => {
    expect(FeatureMapProjectionSchema.safeParse({
      ...validProjection,
      features: []
    }).success).toBe(false);
  });

  it("rejects a non-version-1 projection", () => {
    expect(FeatureMapProjectionSchema.safeParse({
      ...validProjection,
      version: 2
    }).success).toBe(false);
  });

  it("rejects observations exceeding attempts", () => {
    expect(FeatureMapProjectionSchema.safeParse({
      ...validProjection,
      transitions: [{
        ...validProjection.transitions[0],
        observations: { attempts: 1, successes: 2, recoveryCost: 0 }
      }]
    }).success).toBe(false);
  });
});