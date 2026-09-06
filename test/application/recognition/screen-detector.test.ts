import { describe, expect, it } from "vitest";

import { ScreenDetector } from "../../../src/application/recognition/screen-detector.js";
import type {
  AnchorDefinition,
  ScreenDefinition
} from "../../../src/domain/knowledge.js";
import type { RuntimeSnapshot } from "../../../src/domain/runtime-snapshot.js";

const snapshot: RuntimeSnapshot = {
  version: 1,
  generationId: "generation-1",
  baseRevision: 1,
  deviceSerial: "emulator-5554",
  expectedPackageName: "com.example.app",
  foregroundPackageName: "com.example.app",
  activity: "com.example.app.MainActivity",
  pid: 42,
  capturedAt: "2026-09-06T00:00:00.000Z",
  layout: [{
    id: "title",
    resourceId: "com.example.app:id/title",
    text: "Inbox",
    enabled: true,
    children: []
  }]
};

const anchors: AnchorDefinition[] = [
  {
    version: 1,
    id: "main-activity",
    status: "verified",
    roles: ["screenIdentity"],
    identity: {
      kind: "activity",
      activity: "com.example.app.MainActivity"
    }
  },
  {
    version: 1,
    id: "inbox-title",
    status: "verified",
    roles: ["screenIdentity"],
    identity: {
      kind: "element",
      locator: { resourceId: "com.example.app:id/title" }
    }
  },
  {
    version: 1,
    id: "detail-title",
    status: "verified",
    roles: ["screenIdentity"],
    identity: {
      kind: "element",
      locator: { resourceId: "com.example.app:id/detail-title" }
    }
  }
];

function screen(id: string, requiredAnchors: string[]): ScreenDefinition {
  return {
    version: 1,
    id,
    status: "verified",
    requiredAnchors,
    optionalAnchors: [],
    forbiddenAnchors: [],
    predicates: []
  };
}

describe("ScreenDetector", () => {
  it("matches one Screen without requiring executable geometry", () => {
    expect(new ScreenDetector().detect({
      snapshot,
      anchors,
      screens: [
        screen("inbox", ["main-activity", "inbox-title"]),
        screen("detail", ["main-activity", "detail-title"])
      ]
    })).toMatchObject({ status: "matched", screenId: "inbox" });
  });

  it("fails deterministically when multiple Screens share the same facts", () => {
    expect(new ScreenDetector().detect({
      snapshot,
      anchors,
      screens: [
        screen("inbox-a", ["main-activity", "inbox-title"]),
        screen("inbox-b", ["main-activity", "inbox-title"])
      ]
    })).toMatchObject({
      status: "ambiguous",
      screenIds: ["inbox-a", "inbox-b"]
    });
  });

  it("returns unknown instead of guessing unavailable window state", () => {
    const windowAnchor: AnchorDefinition = {
      version: 1,
      id: "permission-window",
      status: "observed",
      roles: ["screenIdentity"],
      identity: { kind: "window", title: "Permission" }
    };
    expect(new ScreenDetector().detect({
      snapshot,
      anchors: [windowAnchor],
      screens: [screen("permission", ["permission-window"])]
    })).toMatchObject({ status: "unknown" });
  });
});
