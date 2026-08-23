import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from "vitest";

import {
  RuntimeObserver
} from "../../../src/application/generation/runtime-observer.js";
import {
  hashRuntimeSnapshot
} from "../../../src/domain/runtime-snapshot.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { ForegroundComponent } from "../../../src/domain/activity.js";
import type { AppProcess } from "../../../src/domain/app-process.js";
import type {
  CaptureScreenOptions
} from "../../../src/ports/android-cli.js";
import type { IdleResult } from "../../../src/application/wait/idle-waiter.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";
import { contextSelection } from "../../fixtures/project-context.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function session(revision = 0): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision,
    state: "active",
    bindings: {
      projectHash: "d".repeat(64),
      configHash: "e".repeat(64),
      contextHash: "a".repeat(64),
      snapshotHash: revision === 0 ? null : "b".repeat(64)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["click", "wait"],
        confirmationRequiredActions: [],
        forbiddenActions: ["back"]
      }
    },
    contextSelection,
    variables: {
      runId: "journey-run-1",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "00ff"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    externalFlows: []
  };
}

class ObservationStore {
  public current = session();
  public readonly jsonEvidence = new Map<string, unknown>();
  public readonly binaryEvidence = new Map<string, Buffer>();
  public failUpdate = false;

  public readonly read = vi.fn(() => Promise.resolve(structuredClone(
    this.current
  )));

  public readonly commitSnapshot = vi.fn((
    id: string,
    expectedRevision: number,
    next: GenerationSession
  ): Promise<void> => {
    if (this.failUpdate || this.current.revision !== expectedRevision) {
      return Promise.reject(new GenerationSessionStoreError(
        "REVISION_CONFLICT",
        "conflict"
      ));
    }
    expect(id).toBe(this.current.id);
    this.current = structuredClone(next);
    return Promise.resolve();
  });

  public readonly writeEvidence = vi.fn((
    _id: string,
    path: string,
    value: unknown
  ): Promise<void> => {
    this.jsonEvidence.set(path, structuredClone(value));
    return Promise.resolve();
  });

  public readonly produceEvidence = vi.fn(async (
    _id: string,
    path: string,
    produce: (temporaryPath: string) => Promise<void>
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "taphound-observer-test-"));
    temporaryRoots.push(root);
    const temporaryPath = join(root, "screen.tmp");
    await produce(temporaryPath);
    this.binaryEvidence.set(path, await readFile(temporaryPath));
  });

  public readonly evidenceReference = vi.fn((
    id: string,
    path: string
  ): Promise<string> => Promise.resolve(
    `.taphound/build/generations/.${id}.work/${path}`
  ));
}

function commandResult(exitCode = 0): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: exitCode === 0 ? "" : "capture failed",
    durationMs: 1,
    timedOut: false,
    cancelled: false
  };
}

interface ObserverHarness {
  store: ObservationStore;
  identities: unknown[];
  adb: {
    foregroundComponent: Mock<() => Promise<ForegroundComponent>>;
    appProcesses: Mock<(identity: unknown) => Promise<readonly AppProcess[]>>;
    windowTopology: Mock<() => Promise<{
      version: 1;
      status: "observed";
      windows: {
        id: string;
        title: string;
        packageName: string;
        touchable: true;
      }[];
    }>>;
  };
  androidCli: {
    layout: Mock<() => Promise<{
      id: string;
      enabled: boolean;
      bounds: { left: number; top: number; right: number; bottom: number };
      children: never[];
    }[]>>;
    captureScreen: Mock<
      (options: CaptureScreenOptions) => Promise<CommandResult>
    >;
  };
  waitUntilIdle: Mock<
    (
      deviceSerial: string,
      config: {
        pollIntervalMs: number;
        stablePolls: number;
        timeoutMs: number;
      },
      signal?: AbortSignal
    ) => Promise<IdleResult>
  >;
  observer: RuntimeObserver;
}

function harness(): ObserverHarness {
  const store = new ObservationStore();
  const identities: unknown[] = [];
  const attemptIds = ["attempt-1", "attempt-2"];
  const adb = {
    foregroundComponent: vi.fn(() => Promise.resolve({
      packageName: "com.android.permissioncontroller",
      activity: "com.android.permissioncontroller.PermissionActivity"
    })),
    appProcesses: vi.fn((identity: unknown) => {
      identities.push(identity);
      return Promise.resolve([]);
    }),
    windowTopology: vi.fn(() => Promise.resolve({
      version: 1 as const,
      status: "observed" as const,
      windows: [{
        id: "window-1",
        title: "MainActivity",
        packageName: "com.example.app",
        touchable: true as const
      }]
    }))
  };
  const androidCli = {
    layout: vi.fn(() => Promise.resolve([{
      id: "root",
      windowId: "window-1",
      enabled: true,
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      children: []
    }])),
    captureScreen: vi.fn(async ({ outputPath }: CaptureScreenOptions) => {
      await writeFile(outputPath, Buffer.from("png-evidence"));
      return commandResult();
    })
  };
  const waitUntilIdle = vi.fn((
    deviceSerial: string,
    config: {
      pollIntervalMs: number;
      stablePolls: number;
      timeoutMs: number;
    },
    signal?: AbortSignal
  ): Promise<IdleResult> => {
    void deviceSerial;
    void config;
    void signal;
    return Promise.resolve({
      status: "stable",
      polls: 2,
      durationMs: 150,
      strategy: "hybrid",
      fallbackUsed: false,
      frameActivityDetected: false,
      samplingDurationMs: 50
    });
  });
  return {
    store,
    adb,
    androidCli,
    waitUntilIdle,
    identities,
    observer: new RuntimeObserver({
      store,
      adb,
      androidCli,
      waitUntilIdle,
      now: (): Date => new Date("2026-07-22T12:05:00.000Z"),
      createAttemptId: () => attemptIds.shift() ?? "unexpected-attempt"
    })
  };
}

describe("RuntimeObserver", () => {
  it("reports a pending confirmation as a structured generation failure", async () => {
    const test = harness();
    test.store.current = {
      ...test.store.current,
      revision: 1,
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        evidenceHash: "c".repeat(64),
        actionSummary: "click send",
        expiresAt: "2026-07-22T12:10:00.000Z",
        status: "pending"
      }
    };

    await expect(test.observer.observe({
      generationId: "generation-1"
    })).rejects.toMatchObject({
      code: "RISK_CONFIRMATION_REQUIRED",
      details: {
        challenge: { challengeId: "challenge-1" }
      }
    });
    expect(test.androidCli.layout).not.toHaveBeenCalled();
  });

  it("waits for a stable layout when observe receives idle config", async () => {
    const test = harness();
    const idle = {
      pollIntervalMs: 150,
      stablePolls: 2,
      timeoutMs: 3000
    };

    await test.observer.observe({
      generationId: "generation-1",
      idle
    });

    expect(test.waitUntilIdle).toHaveBeenCalledWith(
      "emulator-5554",
      idle,
      undefined,
      "com.example.app"
    );
  });

  it("reports structured IDLE_TIMEOUT diagnostics without changing session state", async () => {
    const test = harness();
    test.waitUntilIdle.mockResolvedValueOnce({
      status: "timeout",
      code: "IDLE_TIMEOUT",
      polls: 4,
      durationMs: 3000,
      lastDiff: [{ layoutSha256: "changing" }],
      strategy: "hybrid",
      backend: "uiautomator",
      fallbackUsed: true,
      frameActivityDetected: true,
      samplingDurationMs: 1800
    });

    await expect(test.observer.observe({
      generationId: "generation-1",
      idle: {
        strategy: "hybrid",
        pollIntervalMs: 150,
        stablePolls: 2,
        timeoutMs: 3000
      }
    })).rejects.toMatchObject({
      code: "IDLE_TIMEOUT",
      details: {
        idle: {
          strategy: "hybrid",
          backend: "uiautomator",
          fallbackUsed: true,
          frameActivityDetected: true,
          polls: 4,
          lastDiff: [{ layoutSha256: "changing" }]
        }
      }
    });
    expect(test.store.current).toMatchObject({
      revision: 0,
      state: "active"
    });
  });

  it("persists normalized evidence and commits its authoritative binding", async () => {
    const test = harness();

    const result = await test.observer.observe({
      generationId: "generation-1"
    });

    expect(result.binding).toEqual({
      generationId: "generation-1",
      baseRevision: 1,
      snapshotHash: result.snapshotHash
    });
    expect(result.snapshotRef).toMatch(
      /^\.taphound\/build\/generations\/\.generation-1\.work\/evidence\/snapshots\/revision-000001\/[^/]+\/snapshot\.json$/
    );
    expect(result.snapshot).toMatchObject({
      version: 1,
      generationId: "generation-1",
      baseRevision: 1,
      deviceSerial: "emulator-5554",
      expectedPackageName: "com.example.app",
      foregroundPackageName: "com.android.permissioncontroller",
      activity: "com.android.permissioncontroller.PermissionActivity",
      pid: null,
      capturedAt: "2026-07-22T12:05:00.000Z",
      layout: [{ id: "root", windowId: "window-1", children: [] }],
      windowHierarchy: {
        status: "complete",
        semanticWindowIds: ["window-1"],
        diagnostics: [],
        recovery: []
      }
    });
    expect(result.snapshotHash).toBe(hashRuntimeSnapshot(result.snapshot));
    expect(test.store.current).toMatchObject({
      revision: 1,
      bindings: { snapshotHash: result.snapshotHash }
    });
    expect(test.identities).toEqual([
      {
        packageName: "com.example.app",
        deviceSerial: "emulator-5554"
      },
      {
        packageName: "com.example.app",
        deviceSerial: "emulator-5554"
      }
    ]);
    expect(test.store.binaryEvidence.get(
      "evidence/snapshots/revision-000001/attempt-1/screen.png"
    )).toEqual(Buffer.from("png-evidence"));
    expect(test.store.jsonEvidence.get(
      "evidence/snapshots/revision-000001/attempt-1/snapshot.json"
    )).toEqual(result.snapshot);
  });

  it("commits an already collected post-action runtime without recapturing layout", async () => {
    const test = harness();
    test.adb.foregroundComponent.mockResolvedValue({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    });
    test.adb.appProcesses.mockResolvedValue([
      { pid: 42, name: "com.example.app" }
    ]);

    const result = await test.observer.observeCollected({
      generationId: "generation-1",
      runtime: {
        foregroundPackageName: "com.example.app",
        activity: "com.example.app.MainActivity",
        pid: 42,
        layout: [{
          id: "root",
          windowId: "window-1",
          enabled: true,
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          children: []
        }],
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
        }
      }
    });

    expect(result.snapshot).toMatchObject({
      foregroundPackageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 42
    });
    expect(test.androidCli.layout).not.toHaveBeenCalled();
    expect(test.adb.foregroundComponent).toHaveBeenCalledTimes(1);
    expect(test.adb.appProcesses).toHaveBeenCalledTimes(1);
    expect(test.adb.windowTopology).not.toHaveBeenCalled();
    expect(test.waitUntilIdle).not.toHaveBeenCalled();
    expect(test.androidCli.captureScreen).toHaveBeenCalledTimes(1);
  });

  it("rejects a torn snapshot when runtime identity changes during capture", async () => {
    const test = harness();
    test.adb.foregroundComponent
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: "com.example.app.MainActivity"
      })
      .mockResolvedValueOnce({
        packageName: "com.example.app",
        activity: "com.example.app.SecondActivity"
      });
    test.adb.appProcesses.mockResolvedValue([
      { pid: 42, name: "com.example.app" }
    ]);

    await expect(test.observer.observe({
      generationId: "generation-1"
    })).rejects.toMatchObject({ code: "SNAPSHOT_STALE" });

    expect(test.store.commitSnapshot).not.toHaveBeenCalled();
  });

  it("persists incomplete hierarchy diagnostics when app windows exceed roots", async () => {
    const test = harness();
    test.adb.windowTopology.mockResolvedValueOnce({
      version: 1,
      status: "observed",
      windows: [
        {
          id: "window-1",
          title: "MainActivity",
          packageName: "com.example.app",
          touchable: true
        },
        {
          id: "popup-window",
          title: "PopupWindow",
          packageName: "com.example.app",
          touchable: true
        }
      ]
    });

    const result = await test.observer.observe({
      generationId: "generation-1"
    });

    expect(result.snapshot.windowHierarchy).toMatchObject({
      status: "incomplete",
      diagnostics: [{
        code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT"
      }],
      recovery: [
        "REOBSERVE",
        "LAYOUT_INSPECTOR",
        "DEBUG_WINDOW_INSPECTOR"
      ]
    });
  });

  it("creates a fresh committed revision for repeated observations", async () => {
    const test = harness();

    const first = await test.observer.observe({
      generationId: "generation-1"
    });
    const second = await test.observer.observe({
      generationId: "generation-1"
    });

    expect(first.binding.baseRevision).toBe(1);
    expect(second.binding.baseRevision).toBe(2);
    expect(second.snapshotHash).not.toBe(first.snapshotHash);
    expect(test.store.current.revision).toBe(2);
  });

  it.each([
    ["foreground ADB", (test: ReturnType<typeof harness>): void => {
      test.adb.foregroundComponent.mockRejectedValueOnce(
        new Error("foreground failed")
      );
    }],
    ["PID ADB", (test: ReturnType<typeof harness>): void => {
      test.adb.appProcesses.mockRejectedValueOnce(new Error("pid failed"));
    }],
    ["layout", (test: ReturnType<typeof harness>): void => {
      test.androidCli.layout.mockRejectedValueOnce(new Error("layout failed"));
    }],
    ["window topology", (test: ReturnType<typeof harness>): void => {
      test.adb.windowTopology.mockRejectedValueOnce(
        new Error("window topology cancelled")
      );
    }],
    ["screenshot", (test: ReturnType<typeof harness>): void => {
      test.androidCli.captureScreen.mockResolvedValueOnce(commandResult(1));
    }]
  ])("does not publish state when %s observation fails", async (
    _name,
    fail
  ) => {
    const test = harness();
    fail(test);

    await expect(test.observer.observe({
      generationId: "generation-1"
    })).rejects.toThrow();

    expect(test.store.current).toEqual(session());
    expect(test.store.commitSnapshot).not.toHaveBeenCalled();
  });

  it("leaves CAS-conflicted evidence non-authoritative", async () => {
    const test = harness();
    test.store.failUpdate = true;

    await expect(test.observer.observe({
      generationId: "generation-1"
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    expect(test.store.current).toEqual(session());
    expect(test.store.jsonEvidence.size).toBe(1);
    expect(test.store.binaryEvidence.size).toBe(1);
  });

  it("rejects non-active bound sessions before observing the device", async () => {
    const test = harness();
    test.store.current = {
      ...session(),
      state: "recoveryRequired",
      candidateSteps: [{
        action: "wait",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      }],
      candidateSources: ["planner"],
      inFlight: {
        stepIndex: 1,
        snapshotHash: "b".repeat(64),
        proposalHash: "c".repeat(64),
        attemptId: "attempt-1"
      }
    };

    await expect(test.observer.observe({
      generationId: "generation-1"
    })).rejects.toThrow(/active/i);
    expect(test.adb.foregroundComponent).not.toHaveBeenCalled();
  });
});
