import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type {
  CliDependencies,
  TextOutput
} from "../../src/cli/dependencies.js";
import { TargetError } from "../../src/domain/target.js";
import { hashRuntimeSnapshot } from "../../src/domain/runtime-snapshot.js";
import { runtimeConfig } from "../fakes/runtime-fixture.js";
import {
  contextSelection,
  projectContextIndex,
  resolvedProjectContext
} from "../fixtures/project-context.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const resolvedTarget = {
  id: "work-app",
  sourceType: "local" as const,
  configuredPath: "${TAPHOUND_WORK_APP}",
  resolvedPath: "/real/app",
  project: {
    rootDir: "/real/app",
    settingsFile: "/real/app/settings.gradle.kts",
    gitRoot: "/real/app"
  },
  workspaceRoot: "/ws"
};

const targetEntry = {
  id: "work-app",
  override: false,
  source: { type: "local" as const, path: "${TAPHOUND_WORK_APP}" },
  run: { packageName: "com.example.app", activity: ".MainActivity" }
};

const snapshot = {
  version: 1 as const,
  generationId: "generation-1",
  baseRevision: 2,
  deviceSerial: "emulator-5554",
  expectedPackageName: "com.example.app",
  foregroundPackageName: "com.example.app",
  activity: "com.example.app.MainActivity",
  pid: 42,
  capturedAt: "2026-07-23T00:00:00.000Z",
  layout: []
};

const binding = {
  generationId: "generation-1",
  baseRevision: 2,
  snapshotHash: hashRuntimeSnapshot(snapshot)
};

interface Harness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  start: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  runtimeCalls: Array<{
    projectRoot: string;
    workspaceRoot?: string | undefined;
  }>;
  resolve: ReturnType<typeof vi.fn>;
  fingerprint: ReturnType<typeof vi.fn>;
  assertProjectUnchanged: ReturnType<typeof vi.fn>;
  contextLoad: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  const contextLoad = vi.fn(() => Promise.resolve({
    context: resolvedProjectContext,
    modules: resolvedProjectContext.selection.modules
  }));
  const resolve = vi.fn(() => Promise.resolve(resolvedTarget));
  const fingerprint = vi.fn(() => Promise.resolve({
    hash: "a".repeat(64)
  }));
  const assertProjectUnchanged = vi.fn(() => Promise.resolve());
  const start = vi.fn(() => Promise.resolve({
    id: "generation-1",
    revision: 0,
    bindings: {
      configHash: "b".repeat(64),
      contextSelectionHash: "c".repeat(64),
      projectHash: "d".repeat(64),
      deviceHash: "e".repeat(64)
    },
    contextSelection,
    variables: {},
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    },
    externalFlows: []
  }));
  const observe = vi.fn(() => Promise.resolve({
    binding,
    snapshot,
    snapshotHash: binding.snapshotHash,
    snapshotRef: "snapshot-ref-1"
  }));
  const finalize = vi.fn(() => Promise.resolve({
    status: "verified" as const,
    journey: {
      version: 2 as const,
      name: "generated",
      devices: [{ role: "default" as const }],
      steps: []
    },
    meta: {},
    bundlePath: "/ws/generations/final/generation-1",
    journeyPath: "/ws/journeys/generated.json",
    metaPath: "/ws/journeys/generated.meta.json",
    replayed: true
  }));
  const runtimeCalls: Array<{
    projectRoot: string;
    workspaceRoot?: string | undefined;
  }> = [];
  const runtime = {
    assertConfigIdentity: vi.fn(() => Promise.resolve()),
    finalizer: { finalize },
    observer: { observe },
    confirmation: { request: vi.fn(), confirmStored: vi.fn(), findPendingManual: vi.fn() },
    executor: { execute: vi.fn() },
    readSession: vi.fn(() => Promise.resolve({
      revision: 1,
      contextSelection,
      verification: { status: "notRun" as const },
      publication: { status: "notRun" as const }
    })),
    readContextSnapshot: vi.fn(() => Promise.resolve(resolvedProjectContext))
  };
  const dependencies = {
    cwd: (): string => "/project",
    signal: undefined,
    readJson: vi.fn((path: string) => Promise.resolve(
      path.includes("context") ? projectContextIndex : runtimeConfig
    )),
    stdout,
    stderr,
    setExitCode: (code: number): void => {
      exitCodes.push(code);
    },
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed",
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node", status: "passed", version: "24.1.0" },
          { name: "adb", status: "passed", version: "1.0.41" }
        ]
      }))
    },
    projectDescriber: {
      describe: vi.fn(() => Promise.resolve({
        projectRoot: "/real/app",
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      }))
    },
    contextValidator: {
      validate: vi.fn(() => Promise.resolve({ status: "valid" }))
    },
    contextLoader: {
      load: contextLoad,
      readIndex: vi.fn(() => Promise.resolve({
        bundle: projectContextIndex,
        indexHash: contextSelection.indexHash
      }))
    },
    generationStarter: { start },
    generationRuntime: (input: {
      projectRoot: string;
      workspaceRoot?: string | undefined;
    }): typeof runtime => {
      runtimeCalls.push(input);
      return runtime;
    },
    localTargets: {
      targetsHome: (): string => "/base",
      configStore: {
        loadTargets: vi.fn(() => Promise.resolve({
          targets: { "work-app": targetEntry },
          official: undefined,
          local: undefined
        })),
        appendLocalTarget: vi.fn(),
        removeLocalTarget: vi.fn()
      },
      pathResolver: { resolve: vi.fn() },
      workspace: { root: vi.fn() },
      targetResolver: (_home: string): {
        resolve: typeof resolve;
        fingerprint: typeof fingerprint;
      } => {
        void _home;
        return { resolve, fingerprint };
      },
      localTargetService: (_home: string): {
        configForTarget: typeof import("../../src/application/target/local-target-service.js").LocalTargetService.prototype.configForTarget;
        assertProjectUnchanged: typeof assertProjectUnchanged;
      } => {
        void _home;
        return {
          configForTarget: () => ({
            version: 1,
            run: {
              packageName: "com.example.app",
              activity: ".MainActivity"
            },
            idle: {
              strategy: "hybrid" as const,
              pollIntervalMs: 200,
              stablePolls: 2,
              timeoutMs: 5000
            },
            artifactsDir: "/ws/runs"
          }),
          assertProjectUnchanged
        };
      },
    }
  } as unknown as CliDependencies;
  return {
    dependencies,
    stdout,
    stderr,
    exitCodes,
    start,
    observe,
    finalize,
    runtimeCalls,
    resolve,
    fingerprint,
    assertProjectUnchanged,
    contextLoad
  };
}

async function run(
  test: Harness,
  args: readonly string[]
): Promise<void> {
  await createProgram(test.dependencies).parseAsync(["node", "taphound", ...args]);
}

describe("generation --target", () => {
  it("starts a session against a registered local target with synthesized config", async () => {
    const test = harness();
    await run(test, [
      "generation", "start",
      "--target", "work-app",
      "--module", ":app",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([0]);
    const payload = JSON.parse(test.stdout.value) as Record<string, unknown>;
    expect(payload.status).toBe("started");
    expect(payload.generationId).toBe("generation-1");
    const startInput = test.start.mock.calls[0]?.[0] as {
      projectRoot: string;
      workspaceRoot: string;
      config: Record<string, unknown>;
    };
    expect(startInput.projectRoot).toBe("/real/app");
    expect(startInput.workspaceRoot).toBe("/ws");
    expect(startInput.config).toMatchObject({
      run: { packageName: "com.example.app", activity: ".MainActivity" },
      artifactsDir: "/ws/runs"
    });
    const loadInput = test.contextLoad.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loadInput.projectRoot).toBe("/real/app");
    expect(loadInput.workspaceRoot).toBe("/ws");
    expect(loadInput.contextPath).toBe("/ws/context/project-context.json");
    expect(loadInput.allowIncomplete).toBe(true);
  });

  it("rejects reusable flows for registered local targets", async () => {
    const test = harness();
    await run(test, [
      "generation", "start",
      "--target", "work-app",
      "--base-flow", "bootstrap",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([2]);
    const payload = JSON.parse(test.stdout.value) as {
      failure: { code: string };
    };
    expect(payload.failure.code).toBe("FLOW_INVALID");
    expect(test.start).not.toHaveBeenCalled();
  });

  it("threads workspaceRoot into the generation runtime for observe", async () => {
    const test = harness();
    await run(test, [
      "generation", "observe",
      "--session", "generation-1",
      "--target", "work-app",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([0]);
    const payload = JSON.parse(test.stdout.value) as Record<string, unknown>;
    expect(payload.status).toBe("observed");
    expect(payload.snapshotRef).toBe("snapshot-ref-1");
    expect(test.runtimeCalls).toHaveLength(1);
    expect(test.runtimeCalls[0]?.projectRoot).toBe("/real/app");
    expect(test.runtimeCalls[0]?.workspaceRoot).toBe("/ws");
    expect(test.observe).toHaveBeenCalled();
  });

  it("threads workspaceRoot into finalize", async () => {
    const test = harness();
    await run(test, [
      "generation", "finalize",
      "--session", "generation-1",
      "--target", "work-app",
      "--output", "journeys/generated.json",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([0]);
    const payload = JSON.parse(test.stdout.value) as Record<string, unknown>;
    expect(payload.status).toBe("verified");
    expect(test.runtimeCalls).toHaveLength(1);
    expect(test.runtimeCalls[0]?.projectRoot).toBe("/real/app");
    expect(test.runtimeCalls[0]?.workspaceRoot).toBe("/ws");
    const finalizeInput = test.finalize.mock.calls[0]?.[0] as {
      projectRoot: string;
      workspaceRoot: string;
      outputPath: string;
    };
    expect(finalizeInput.projectRoot).toBe("/real/app");
    expect(finalizeInput.workspaceRoot).toBe("/ws");
    expect(finalizeInput.outputPath).toBe("journeys/generated.json");
  });

  it("fails with LOCAL_TARGET_NOT_FOUND for an unknown target", async () => {
    const test = harness();
    test.resolve.mockRejectedValue(
      new TargetError("LOCAL_TARGET_NOT_FOUND", "no such target")
    );
    await run(test, [
      "generation", "start",
      "--target", "nope",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([2]);
    const payload = JSON.parse(test.stdout.value) as {
      failure: { code: string };
    };
    expect(payload.failure.code).toBe("LOCAL_TARGET_NOT_FOUND");
  });

  it("fails with LOCAL_TARGET_PROJECT_CHANGED on fingerprint drift", async () => {
    const test = harness();
    test.assertProjectUnchanged.mockRejectedValue(
      new TargetError("LOCAL_TARGET_PROJECT_CHANGED", "switched project")
    );
    await run(test, [
      "generation", "start",
      "--target", "work-app",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([2]);
    const payload = JSON.parse(test.stdout.value) as {
      failure: { code: string };
    };
    expect(payload.failure.code).toBe("LOCAL_TARGET_PROJECT_CHANGED");
  });
});