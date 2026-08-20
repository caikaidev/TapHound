import { describe, expect, it } from "vitest";

import {
  RuntimeSnapshotSchema,
  hashRuntimeSnapshot
} from "../../src/domain/runtime-snapshot.js";

function validSnapshot(): unknown {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 1,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.system",
    activity: "com.example.app.MainActivity",
    pid: null,
    capturedAt: "2026-07-22T12:00:00.000Z",
    screenshotPath: ".taphound/snapshots/current.png",
    layout: [{
      id: "root",
      resourceId: "screen",
      enabled: true,
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      children: []
    }]
  };
}

describe("RuntimeSnapshotSchema", () => {
  it("parses a strict runtime snapshot", () => {
    expect(RuntimeSnapshotSchema.parse(validSnapshot())).toEqual(validSnapshot());
  });

  it("rejects unknown fields and direct-coordinate aliases", () => {
    expect(() => RuntimeSnapshotSchema.parse({
      ...(validSnapshot() as object),
      x: 100,
      y: 200
    })).toThrow();
  });
});

describe("hashRuntimeSnapshot", () => {
  it("is canonical across object key order", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    expect(hashRuntimeSnapshot(snapshot)).toBe(hashRuntimeSnapshot({
      layout: snapshot.layout,
      screenshotPath: snapshot.screenshotPath,
      capturedAt: snapshot.capturedAt,
      pid: snapshot.pid,
      activity: snapshot.activity,
      foregroundPackageName: snapshot.foregroundPackageName,
      expectedPackageName: snapshot.expectedPackageName,
      deviceSerial: snapshot.deviceSerial,
      baseRevision: snapshot.baseRevision,
      generationId: snapshot.generationId,
      version: snapshot.version
    }));
  });

  it("does not include capture time or artifact paths", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    expect(hashRuntimeSnapshot(snapshot)).toBe(hashRuntimeSnapshot({
      ...snapshot,
      capturedAt: "2026-07-22T13:00:00.000Z",
      screenshotPath: "/another/machine/current.png"
    }));
  });

  it("changes when executable runtime content changes", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    expect(hashRuntimeSnapshot(snapshot)).not.toBe(hashRuntimeSnapshot({
      ...snapshot,
      activity: "com.example.app.SearchActivity"
    }));
  });

  it("binds window hierarchy completeness and diagnostics", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    expect(hashRuntimeSnapshot(snapshot)).not.toBe(hashRuntimeSnapshot({
      ...snapshot,
      windowHierarchy: {
        status: "incomplete",
        appWindows: [{
          id: "popup-window",
          title: "PopupWindow",
          packageName: "com.example.app",
          touchable: true
        }],
        semanticWindowIds: [],
        diagnostics: [{
          code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT",
          message: "PopupWindow lacks a semantic root"
        }],
        recovery: [
          "REOBSERVE",
          "LAYOUT_INSPECTOR",
          "DEBUG_WINDOW_INSPECTOR"
        ]
      }
    }));
  });

  it("binds generation, revision, device, foreground identity, and PID", () => {
    const snapshot = validSnapshot() as Record<string, unknown>;
    for (const change of [
      { generationId: "generation-2" },
      { baseRevision: 2 },
      { deviceSerial: "device-2" },
      { expectedPackageName: "com.other.app" },
      { foregroundPackageName: "com.example.app" },
      { activity: "com.example.app.SearchActivity" },
      { pid: 42 }
    ]) {
      expect(hashRuntimeSnapshot(snapshot)).not.toBe(hashRuntimeSnapshot({
        ...snapshot,
        ...change
      }));
    }
  });
});
