import { describe, expect, it } from "vitest";

import {
  FlowNameSchema,
  FlowSchema,
  JourneySourcePathSchema,
  JourneySourceSchema,
  ResolvedJourneyPathSchema
} from "../../src/domain/journey-composition.js";

const activity = {
  before: "com.example.app.MainActivity",
  after: "com.example.app.MainActivity"
};

describe("Journey composition schemas", () => {
  it("accepts strict reusable Flow and Journey source documents", () => {
    expect(FlowSchema.parse({
      version: 1,
      kind: "flow",
      name: "core/authenticated-home",
      includes: [],
      steps: [{ action: "wait", activity }]
    }).name).toBe("core/authenticated-home");

    expect(JourneySourceSchema.parse({
      version: 1,
      kind: "journeySource",
      name: "chat/send-message",
      includes: ["chat/open-thread"],
      steps: [{ action: "wait", activity }]
    }).includes).toEqual(["chat/open-thread"]);
  });

  it.each([
    "",
    "/core/home",
    "core/home/",
    "core//home",
    "core/../home",
    String.raw`core\home`,
    "core/{home}"
  ])("rejects unsafe Flow name %s", (name) => {
    expect(() => FlowNameSchema.parse(name)).toThrow();
  });

  it("rejects duplicate includes and unknown fields", () => {
    expect(() => FlowSchema.parse({
      version: 1,
      kind: "flow",
      name: "chat/open-thread",
      includes: ["core/home", "core/home"],
      steps: [{ action: "wait", activity }]
    })).toThrow();
    expect(() => JourneySourceSchema.parse({
      version: 1,
      kind: "journeySource",
      name: "chat/send",
      includes: [],
      steps: [{ action: "wait", activity }],
      description: "not allowed"
    })).toThrow();
  });

  it("requires conventional source and resolved Journey paths", () => {
    expect(JourneySourcePathSchema.parse(
      ".taphound/sources/chat/send.json"
    )).toBe(".taphound/sources/chat/send.json");
    expect(ResolvedJourneyPathSchema.parse(
      ".taphound/journeys/chat/send.json"
    )).toBe(".taphound/journeys/chat/send.json");
    expect(() => JourneySourcePathSchema.parse(
      ".taphound/journeys/chat/send.json"
    )).toThrow();
    expect(() => ResolvedJourneyPathSchema.parse(
      ".taphound/build/generated.json"
    )).toThrow();
  });
});
