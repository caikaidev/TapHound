import { describe, expect, it, vi } from "vitest";

import {
  SnapshotReobservationGuard
} from "../../../src/application/generation/runtime-observer.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { ProposalBinding } from "../../../src/domain/proposed-step.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";
import { contextSelection } from "../../fixtures/project-context.js";

const layout = [{
  id: "root",
  windowId: "window-1",
  enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 200 },
  children: []
}];

function snapshot(
  overrides: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 1,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.app",
    activity: "com.example.app.MainActivity",
    pid: 42,
    capturedAt: "2026-07-22T12:00:00.000Z",
    screenshotPath: "evidence/original/screen.png",
    layout,
    windowHierarchy: {
      status: "complete",
      appWindows: [{
        id: "window-1",
        title: "MainActivity",
        packageName: "com.example.app",
        touchable: true
      }],
      semanticWindowIds: ["window-1"],
      diagnostics: [],
      recovery: []
    },
    ...overrides
  };
}

function session(overrides: Partial<GenerationSession> = {}): GenerationSession {
  const runtimeHash = hashRuntimeSnapshot(snapshot());
  return {
    version: 1,
    id: "generation-1",
    revision: 1,
    state: "active",
    bindings: {
      projectHash: "d".repeat(64),
      configHash: "e".repeat(64),
      contextHash: "a".repeat(64),
      snapshotHash: runtimeHash
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click"],
        confirmationRequiredActions: [],
        forbiddenActions: ["back"]
      }
    },
    contextSelection,
    variables: {
      runId: "run-1",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "00ff"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    externalFlows: [],
    ...overrides
  };
}

function harness(): {
  current: GenerationSession;
  read: ReturnType<typeof vi.fn>;
  foregroundComponent: ReturnType<typeof vi.fn>;
  appProcesses: ReturnType<typeof vi.fn>;
  readLayout: ReturnType<typeof vi.fn>;
  guard: SnapshotReobservationGuard;
} {
  const current = session();
  const read = vi.fn(() => Promise.resolve(current));
  const foregroundComponent = vi.fn(() => Promise.resolve({
    packageName: "com.example.app",
    activity: "com.example.app.MainActivity"
  }));
  const appProcesses = vi.fn(() => Promise.resolve([
    { pid: 42, name: "com.example.app" }
  ]));
  const windowTopology = vi.fn(() => Promise.resolve({
    version: 1 as const,
    status: "observed" as const,
    windows: [{
      id: "window-1",
      title: "MainActivity",
      packageName: "com.example.app",
      touchable: true
    }]
  }));
  const readLayout = vi.fn(() => Promise.resolve(layout));
  return {
    current,
    read,
    foregroundComponent,
    appProcesses,
    readLayout,
    guard: new SnapshotReobservationGuard({
      store: { read },
      adb: { foregroundComponent, appProcesses, windowTopology },
      androidCli: { layout: readLayout },
      now: () => new Date("2026-07-22T12:10:00.000Z")
    })
  };
}

function binding(test: ReturnType<typeof harness>): ProposalBinding {
  const snapshotHash = test.current.bindings.snapshotHash;
  if (snapshotHash === null) {
    throw new Error("Test session requires a snapshot");
  }
  return {
    generationId: "generation-1",
    baseRevision: 1,
    snapshotHash
  };
}

describe("SnapshotReobservationGuard", () => {
  it("recomputes the bound snapshot without mutating authoritative state", async () => {
    const test = harness();

    const observed = await test.guard.assertFresh(binding(test));

    expect(hashRuntimeSnapshot(observed)).toBe(
      test.current.bindings.snapshotHash
    );
    expect(observed).toMatchObject({
      generationId: "generation-1",
      baseRevision: 1,
      capturedAt: "2026-07-22T12:10:00.000Z"
    });
    expect(test.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["generation", { generationId: "generation-2" }],
    ["revision", { baseRevision: 2 }],
    ["proposal hash", { snapshotHash: "f".repeat(64) }]
  ])("returns SNAPSHOT_STALE for a mismatched %s binding", async (
    _name,
    mismatch
  ) => {
    const test = harness();

    await expect(test.guard.assertFresh({
      ...binding(test),
      ...mismatch
    })).rejects.toMatchObject({ code: "SNAPSHOT_STALE" });
    expect(test.foregroundComponent).not.toHaveBeenCalled();
  });

  it.each([
    ["foreground package", (test: ReturnType<typeof harness>): void => {
      test.foregroundComponent.mockResolvedValueOnce({
        packageName: "com.android.systemui",
        activity: "com.android.systemui.DialogActivity"
      });
    }],
    ["PID", (test: ReturnType<typeof harness>): void => {
      test.appProcesses.mockResolvedValueOnce([
        { pid: 99, name: "com.example.app" }
      ]);
    }],
    ["Layout", (test: ReturnType<typeof harness>): void => {
      test.readLayout.mockResolvedValueOnce([{
        ...layout[0],
        children: [{
          id: "changed",
          enabled: true,
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          children: []
        }]
      }]);
    }]
  ])("returns SNAPSHOT_STALE when fresh %s differs", async (_name, change) => {
    const test = harness();
    change(test);

    await expect(
      test.guard.assertFresh(binding(test))
    ).rejects.toMatchObject({ code: "SNAPSHOT_STALE" });
  });

  it("lets only the exact approved challenge bridge confirmation revisions", async () => {
    const test = harness();
    const approved = {
      challengeId: "challenge-1",
      stepIndex: 0,
      proposalHash: "c".repeat(64),
      snapshotHash: binding(test).snapshotHash,
      evidenceHash: "e".repeat(64),
      actionSummary: "click submit",
      expiresAt: "2026-07-22T12:20:00.000Z",
      status: "approved" as const
    };
    test.current.revision = 3;
    test.current.pendingConfirmation = approved;

    await expect(test.guard.assertFresh(
      binding(test),
      undefined,
      approved
    )).resolves.toMatchObject({ baseRevision: 1, pid: 42 });
    await expect(test.guard.assertFresh(
      binding(test),
      undefined,
      { ...approved, challengeId: "challenge-2" }
    )).rejects.toMatchObject({ code: "SNAPSHOT_STALE" });
    test.current.revision = 4;
    await expect(test.guard.assertFresh(
      binding(test),
      undefined,
      approved
    )).rejects.toMatchObject({ code: "SNAPSHOT_STALE" });
  });
});
