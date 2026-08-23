import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  ConfirmationRequestResult
} from "../../src/application/generation/generation-confirmation-service.js";
import type {
  GenerationRecoveryStatus
} from "../../src/application/generation/generation-recovery-service.js";
import {
  GenerationOperationError,
  hashGenerationBinding
} from "../../src/application/generation/generation-starter.js";
import {
  GenerationPromptCancelledError
} from "../../src/ports/generation-prompt.js";
import { createProgram } from "../../src/cli/program.js";
import type {
  CliDependencies,
  TextOutput
} from "../../src/cli/dependencies.js";
import {
  createProductionDependencies
} from "../../src/cli/dependencies.js";
import type {
  GenerationSessionStore
} from "../../src/ports/generation-session-store.js";
import { hashRuntimeSnapshot } from "../../src/domain/runtime-snapshot.js";
import { runtimeConfig } from "../fakes/runtime-fixture.js";
import {
  fakeWorkspaceLayout,
  type FakeWorkspaceLayout
} from "../fakes/workspace-layout.js";
import {
  contextSelection,
  projectContextIndex,
  projectContextModule,
  resolvedProjectContext
} from "../fixtures/project-context.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

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

const proposal = {
  action: "wait" as const,
  binding: {
    generationId: "generation-1",
    baseRevision: 2,
    snapshotHash: hashRuntimeSnapshot(snapshot)
  },
  activity: { before: "com.example.app.MainActivity" }
};

const generationContext = resolvedProjectContext;

interface Harness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  request: Mock<() => Promise<ConfirmationRequestResult>>;
  execute: Mock;
  confirmStored: Mock;
  findPendingManual: Mock;
  requestManual: Mock;
  observe: Mock;
  finalize: Mock;
  assertConfigIdentity: Mock;
  recoveryStatus: Mock;
  retry: Mock;
  archive: Mock;
  list: Mock;
  workspaceLayout: FakeWorkspaceLayout;
}

function harness(signal?: AbortSignal): Harness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  const workspaceLayout = fakeWorkspaceLayout();
  const request = vi.fn<() => Promise<ConfirmationRequestResult>>(() => Promise.resolve({
    status: "approved" as const,
    proposal
  }));
  const execute = vi.fn(() => Promise.resolve({
    status: "succeeded" as const,
    step: {
      action: "wait" as const,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      }
    }
  }));
  const confirmStored = vi.fn(() => Promise.resolve({
    status: "approved" as const,
    proposal,
    snapshot,
    source: "planner" as const
  }));
  const requestManual = vi.fn(() => Promise.resolve({
    status: "approved" as const,
    proposal
  }));
  const findPendingManual = vi.fn(() => Promise.resolve(null));
  const observe = vi.fn(() => Promise.resolve({
    binding: proposal.binding,
    snapshot,
    snapshotHash: proposal.binding.snapshotHash
  }));
  const finalize = vi.fn(() => Promise.resolve({
    status: "verified" as const,
    journey: {
      version: 1 as const,
      name: "Generated",
      steps: []
    },
    meta: {},
    bundlePath: "/project/.taphound/build/generations/final/generation-1",
    journeyPath: "/project/.taphound/journeys/generated.json",
    metaPath: "/project/.taphound/journeys/generated.meta.json",
    replayed: true
  }));
  const assertConfigIdentity = vi.fn(() => Promise.resolve());
  const recoveryStatus = vi.fn(() => Promise.resolve({
    generationId: "generation-1",
    revision: 4,
    state: "active" as const,
    candidateStepCount: 1,
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" as const },
    publication: { status: "notRun" as const },
    recovery: {
      available: false,
      kind: null,
      actionMayHaveExecuted: false,
      attemptOutcome: null,
      requiredDecision: null,
      ownerAlive: null
    }
  }));
  const retry = vi.fn(() => Promise.resolve({
    revision: 5
  }));
  const archive = vi.fn(() => Promise.resolve({
    id: "generation-1",
    revision: 5,
    state: "archived" as const
  }));
  const list = vi.fn(() => Promise.resolve([
    {
      id: "generation-1",
      revision: 5,
      state: "archived" as const,
      candidateSteps: [],
      candidateSources: [],
      verification: { status: "notRun" as const },
      publication: { status: "notRun" as const }
    }
  ]));
  const readSession = vi.fn(() => Promise.resolve({
    revision: 4,
    candidateSteps: [{}],
    contextSelection
  }));
  const dependencies = {
    ...(signal === undefined ? {} : { signal }),
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.1.0" },
          { name: "adb" as const, status: "passed" as const, version: "1.0.41" },
          { name: "android" as const, status: "passed" as const, version: "0.2.0" }
        ]
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    projectDescriber: {
      describe: vi.fn(() => Promise.resolve({
        projectRoot: "/project",
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      }))
    },
    contextValidator: { validate: vi.fn() },
    contextLoader: {
      load: vi.fn(() => Promise.resolve({
        context: generationContext,
        binding: generationContext,
        bundle: projectContextIndex,
        modules: [projectContextModule]
      })),
      readIndex: vi.fn(() => Promise.resolve({
        bundle: projectContextIndex,
        indexHash: contextSelection.indexHash
      }))
    },
    init: {
      install: vi.fn(() => Promise.resolve({
        status: "installed" as const,
        exitCode: 0 as const,
        agents: ["droid"],
        paths: [".factory/skills/taphound-ai-journey"]
      }))
    },
    initPrompt: {
      selectAgents: vi.fn(() => Promise.resolve(["droid" as const]))
    },
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
    workspaceLayout,
    generationRuntime: vi.fn(() => ({
      confirmation: {
        request,
        requestManual,
        confirmStored,
        findPendingManual
      },
      executor: { execute },
      observer: { observe },
      finalizer: { finalize },
      recovery: { status: recoveryStatus, retry },
      archive,
      list,
      readSession,
      assertConfigIdentity
    })),
    detachedProcess: {
      launch: vi.fn(() => Promise.resolve({ pid: 4321 }))
    },
    cliEntryPath: "/cli/main.js",
    createDetachedJobId: () => "job-1",
    readJson: vi.fn((path: string) => Promise.resolve(
      path.endsWith("input.json")
        ? { version: 1, proposal, snapshot }
        : runtimeConfig
    )),
    cwd: () => "/project",
    stdout,
    stderr,
    setExitCode: (code: number): void => {
      exitCodes.push(code);
    }
  } as unknown as CliDependencies;
  return {
    dependencies,
    stdout,
    stderr,
    exitCodes,
    request,
    execute,
    confirmStored,
    findPendingManual,
    requestManual,
    observe,
    finalize,
    assertConfigIdentity,
    recoveryStatus,
    retry,
    archive,
    list,
    workspaceLayout
  };
}

function internals(value: unknown): Record<string, unknown> {
  return (value as {
    dependencies: Record<string, unknown>;
  }).dependencies;
}

describe("generation JSON process protocol", () => {
  it("shares one Store identity and exact idle config across production services", async () => {
    const read = vi.fn<() => Promise<unknown>>(
      () => Promise.resolve({ id: "store-sentinel" })
    );
    const store = { read } as unknown as GenerationSessionStore;
    const generationStoreFactory = vi.fn(() => store);
    const dependencies = createProductionDependencies(undefined, {
      generationStoreFactory
    });
    const config = {
      ...runtimeConfig,
      idle: {
        strategy: "hybrid" as const,
        timeoutMs: 12_345,
        pollIntervalMs: 67,
        stablePolls: 4
      }
    };
    const runtime = dependencies.generationRuntime?.({
      projectRoot: "/project",
      config
    });

    expect(runtime).toBeDefined();
    expect(runtime?.confirmation.request).toBeTypeOf("function");
    expect(runtime?.confirmation.confirmStored).toBeTypeOf("function");
    expect(runtime?.executor.execute).toBeTypeOf("function");
    expect(runtime?.observer.observe).toBeTypeOf("function");
    expect(runtime?.finalizer.finalize).toBeTypeOf("function");
    expect(runtime?.recovery.status).toBeTypeOf("function");
    expect(runtime?.readSession).toBeTypeOf("function");
    expect(generationStoreFactory).toHaveBeenCalledTimes(1);
    expect(generationStoreFactory).toHaveBeenCalledWith("/project");
    expect(internals(runtime?.confirmation).store).toBe(store);
    expect(internals(runtime?.executor).store).toBe(store);
    expect(internals(runtime?.observer).store).toBe(store);
    expect(internals(runtime?.finalizer).store).toBe(store);
    expect(internals(runtime?.recovery).store).toBe(store);
    expect(internals(internals(runtime?.finalizer).publisher).store).toBe(
      store
    );
    expect(internals(runtime?.executor).idle).toBe(config.idle);
    read.mockResolvedValueOnce({
      bindings: { configHash: hashGenerationBinding(config) }
    });
    await expect(runtime?.assertConfigIdentity("generation-1"))
      .resolves.toBeUndefined();
    read.mockResolvedValueOnce({
      bindings: { configHash: hashGenerationBinding(runtimeConfig) }
    });
    await expect(runtime?.assertConfigIdentity("generation-1"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await runtime?.readSession("generation-1");
    expect(read).toHaveBeenCalledWith("generation-1");
  });

  it("executes a strict planner envelope and emits exactly one JSON value", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(test.request).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "planner"
    });
    expect(test.execute).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "planner"
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      generationId: "generation-1",
      revision: 4,
      stepIndex: 0
    });
    expect(test.stdout.value.endsWith("\n")).toBe(true);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.exitCodes).toEqual([0]);
  });

  it.each([
    ["observe", []],
    ["step", ["--input", "input.json"]],
    ["confirm", ["--challenge", "challenge-1"]],
    ["manual", ["--action", "wait"]]
  ])("rejects config identity mismatch before generation %s side effects", async (
    command,
    extraArguments
  ) => {
    const test = harness();
    test.assertConfigIdentity.mockRejectedValueOnce(
      new GenerationOperationError("CONFIG_INVALID", "config mismatch")
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", command,
      "--project", "/project",
      "--session", "generation-1",
      ...extraArguments,
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.confirmStored).not.toHaveBeenCalled();
    expect(test.findPendingManual).not.toHaveBeenCalled();
    expect(test.requestManual).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects a legacy workspace layout before any generation work", async () => {
    const test = harness();
    test.workspaceLayout.legacyDirectories = [".taphound/jobs"];

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "observe",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    const output = JSON.parse(test.stdout.value) as {
      exitCode: number;
      failure: { code: string; message: string };
    };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("CONFIG_INVALID");
    expect(output.failure.message).toContain(
      "mv .taphound/jobs .taphound/build/jobs"
    );
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.assertConfigIdentity).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([2]);
  });

  it("maps pending-confirmation observation blocking to structured risk", async () => {
    const test = harness();
    test.observe.mockRejectedValueOnce(new GenerationOperationError(
      "RISK_CONFIRMATION_REQUIRED",
      "Generation confirmation challenge-1 must be resolved before observation",
      {
        challenge: {
          challengeId: "challenge-1",
          expiresAt: "2026-08-21T19:00:00.000Z"
        }
      }
    ));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "observe",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: {
        code: "RISK_CONFIRMATION_REQUIRED",
        details: {
          challenge: { challengeId: "challenge-1" }
        }
      }
    });
  });

  it("rejects unknown planner envelope fields before requesting confirmation", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson).mockResolvedValueOnce(runtimeConfig)
      .mockResolvedValueOnce({
        version: 1,
        proposal,
        snapshot,
        unknown: true
      });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONTEXT_INVALID" }
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([2]);
  });

  it("emits an envelope hint when a flat planner envelope is rejected", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson).mockResolvedValueOnce(runtimeConfig)
      .mockResolvedValueOnce({
        action: "wait",
        binding: proposal.binding,
        activity: { before: "com.example.app.MainActivity" }
      });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    const output = JSON.parse(test.stdout.value) as {
      exitCode: number;
      failure: { code: string; hint: string };
    };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("CONTEXT_INVALID");
    expect(output.failure.hint).toContain("version");
    expect(output.failure.hint).toContain("proposal");
    expect(output.failure.hint).toContain("snapshot");
    expect(test.request).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["observe", ["generation", "observe", "--session", "../invalid"]],
    [
      "step",
      [
        "generation", "step", "--session", "../invalid",
        "--input", "input.json"
      ]
    ],
    [
      "confirm",
      [
        "generation", "confirm", "--session", "../invalid",
        "--challenge", "challenge-1"
      ]
    ],
    [
      "manual",
      [
        "generation", "manual", "--session", "../invalid",
        "--action", "wait"
      ]
    ],
    [
      "finalize",
      [
        "generation", "finalize", "--session", "../invalid",
        "--context", "context.json", "--output", "journey.json"
      ]
    ]
  ])("rejects invalid %s session IDs before side effects", async (
    _command,
    args
  ) => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", ...args, "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2
    });
    expect(test.dependencies.readJson).not.toHaveBeenCalled();
    expect(test.dependencies.runtimeObserver.observe).not.toHaveBeenCalled();
    expect(test.dependencies.doctor.run).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
    expect(test.confirmStored).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("rejects malformed challenge IDs as validation, not confirmation risk", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--session", "generation-1",
      "--challenge", "../invalid",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2
    });
    expect(test.dependencies.readJson).not.toHaveBeenCalled();
    expect(test.confirmStored).not.toHaveBeenCalled();
  });

  it("keeps malformed IDs as exit 2 when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const test = harness(controller.signal);

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--session", "../invalid",
      "--challenge", "challenge-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2
    });
    expect(test.dependencies.readJson).not.toHaveBeenCalled();
    expect(test.confirmStored).not.toHaveBeenCalled();
  });

  it("returns confirmationRequired without executing an action", async () => {
    const test = harness();
    test.request.mockResolvedValueOnce({
      status: "confirmationRequired",
      revision: 3,
      challenge: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        evidenceHash: "e".repeat(64),
        actionSummary: "Wait",
        expiresAt: "2026-07-23T00:05:00.000Z",
        status: "pending"
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "confirmationRequired",
      exitCode: 0,
      generationId: "generation-1",
      challenge: {
        challengeId: "challenge-1",
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64)
      }
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([0]);
  });

  it("surfaces a recovered planner challenge without executing an action", async () => {
    const test = harness();
    test.request.mockResolvedValueOnce({
      status: "confirmationRequired",
      revision: 3,
      challenge: {
        challengeId: "lost-response",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        evidenceHash: "e".repeat(64),
        actionSummary: "Wait",
        expiresAt: "2026-07-23T00:05:00.000Z",
        status: "pending"
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(test.request).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "planner"
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "confirmationRequired",
      exitCode: 0,
      challenge: { challengeId: "lost-response" }
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
  });

  it.each([
    ["SNAPSHOT_STALE" as const, "stale snapshot"],
    [
      "WINDOW_HIERARCHY_INCOMPLETE" as const,
      "visible app window lacks a semantic root"
    ],
    ["ACTION_FORBIDDEN" as const, "forbidden action"],
    ["RECOVERY_REQUIRED" as const, "recovery required"]
  ])("maps deterministic %s rejection to exit 1 without action", async (
    code,
    message
  ) => {
    const test = harness();
    test.request.mockRejectedValueOnce(
      new GenerationOperationError(code, message)
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 1,
      failure: { code, message }
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([1]);
  });

  it("emits structured window-hierarchy recovery details", async () => {
    const test = harness();
    test.request.mockRejectedValueOnce(new GenerationOperationError(
      "WINDOW_HIERARCHY_INCOMPLETE",
      "visible app window lacks a semantic root",
      {
        diagnostics: [{
          code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT",
          message: "visible app window lacks a semantic root"
        }],
        recovery: [
          "REOBSERVE",
          "LAYOUT_INSPECTOR",
          "DEBUG_WINDOW_INSPECTOR"
        ]
      }
    ));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 1,
      failure: {
        code: "WINDOW_HIERARCHY_INCOMPLETE",
        message: "visible app window lacks a semantic root",
        details: {
          diagnostics: [{
            code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT",
            message: "visible app window lacks a semantic root"
          }],
          recovery: [
            "REOBSERVE",
            "LAYOUT_INSPECTOR",
            "DEBUG_WINDOW_INSPECTOR"
          ]
        }
      }
    });
  });

  it("maps step failure and cancellation to one exit-1 JSON result", async () => {
    const failed = harness();
    failed.execute.mockResolvedValueOnce({
      status: "failed",
      failure: {
        code: "IDLE_TIMEOUT",
        message: "Layout did not become stable before timeout",
        details: {
          idle: {
            strategy: "hybrid",
            backend: "uiautomator",
            fallbackUsed: true,
            frameActivityDetected: true,
            polls: 30
          }
        }
      }
    });
    await createProgram(failed.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);
    expect(JSON.parse(failed.stdout.value)).toMatchObject({
      status: "recoveryRequired",
      exitCode: 1,
      generationId: "generation-1",
      failure: {
        code: "IDLE_TIMEOUT",
        details: {
          idle: {
            strategy: "hybrid",
            backend: "uiautomator",
            fallbackUsed: true,
            frameActivityDetected: true,
            polls: 30
          }
        }
      }
    });
    expect(failed.exitCodes).toEqual([1]);

    const cancelled = harness();
    cancelled.execute.mockResolvedValueOnce({
      status: "cancelled",
      failure: { code: "RECOVERY_REQUIRED", message: "Step was cancelled" }
    });
    await createProgram(cancelled.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);
    expect(JSON.parse(cancelled.stdout.value)).toMatchObject({
      status: "recoveryRequired",
      exitCode: 1,
      generationId: "generation-1",
      failure: { code: "RECOVERY_REQUIRED" }
    });
    expect(cancelled.exitCodes).toEqual([1]);
  });

  it("confirms from stored evidence without accepting caller action data", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--json"
    ]);

    expect(test.confirmStored).toHaveBeenCalledWith({
      generationId: "generation-1",
      challengeId: "challenge-1"
    });
    expect(test.execute).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "planner"
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "succeeded",
      source: "planner"
    });
  });

  it("executes an exact delegated approval without requiring a prompt", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--decision", "approve",
      "--json"
    ]);

    expect(test.confirmStored).toHaveBeenCalledWith({
      generationId: "generation-1",
      challengeId: "challenge-1",
      decision: "approve"
    });
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it("clears an exact delegated decline without executing", async () => {
    const test = harness();
    test.confirmStored.mockResolvedValueOnce({ status: "declined" });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--decision", "decline",
      "--json"
    ]);

    expect(test.confirmStored).toHaveBeenCalledWith({
      generationId: "generation-1",
      challengeId: "challenge-1",
      decision: "decline"
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "declined",
      exitCode: 0,
      generationId: "generation-1",
      challengeId: "challenge-1"
    });
  });

  it("rejects an invalid delegated decision before confirmation", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--decision", "always",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(test.confirmStored).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("fails a non-TTY confirmation closed without executing", async () => {
    const test = harness();
    test.confirmStored.mockRejectedValueOnce(
      new Error("Generation confirmation requires local TTY input and diagnostics")
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "RISK_CONFIRMATION_REQUIRED" }
    });
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("maps confirmation prompt cancellation to one exit-1 JSON result", async () => {
    const controller = new AbortController();
    const test = harness(controller.signal);
    test.confirmStored.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new GenerationPromptCancelledError());
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "confirm",
      "--project", "/project",
      "--session", "generation-1",
      "--challenge", "challenge-1",
      "--json"
    ]);

    expect(test.confirmStored).toHaveBeenCalledWith({
      generationId: "generation-1",
      challengeId: "challenge-1",
      signal: controller.signal
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "RECOVERY_REQUIRED" }
    });
    expect(test.exitCodes).toEqual([1]);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("maps manual prompt cancellation and propagates the signal", async () => {
    const controller = new AbortController();
    const test = harness(controller.signal);
    test.requestManual.mockRejectedValueOnce(
      new GenerationPromptCancelledError()
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "manual",
      "--project", "/project",
      "--session", "generation-1",
      "--action", "wait",
      "--json"
    ]);

    expect(test.requestManual).toHaveBeenCalledWith({
      generationId: "generation-1",
      snapshot,
      manual: {
        action: "wait",
        binding: proposal.binding,
        before: snapshot.activity,
        layout: snapshot.layout
      },
      signal: controller.signal
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "RECOVERY_REQUIRED" }
    });
    expect(test.exitCodes).toEqual([1]);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("maps manual resolve-and-abort to one exit-1 JSON result", async () => {
    const controller = new AbortController();
    const test = harness(controller.signal);
    test.requestManual.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new GenerationPromptCancelledError());
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "manual",
      "--project", "/project",
      "--session", "generation-1",
      "--action", "wait",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "RECOVERY_REQUIRED" }
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.exitCodes).toEqual([1]);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("returns an existing manual challenge before observe or prompt", async () => {
    const test = harness();
    test.findPendingManual.mockResolvedValueOnce({
      status: "confirmationRequired",
      revision: 3,
      challenge: {
        challengeId: "manual-lost-response",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        evidenceHash: "e".repeat(64),
        actionSummary: "Wait",
        expiresAt: "2026-07-23T00:05:00.000Z",
        status: "pending"
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "manual",
      "--project", "/project",
      "--session", "generation-1",
      "--action", "wait",
      "--json"
    ]);

    expect(test.findPendingManual).toHaveBeenCalledWith({
      generationId: "generation-1",
      action: "wait"
    });
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.requestManual).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "confirmationRequired",
      exitCode: 0,
      challenge: { challengeId: "manual-lost-response" }
    });
  });

  it("rejects mismatched manual challenge discovery before side effects", async () => {
    const test = harness();
    test.findPendingManual.mockRejectedValueOnce(
      new GenerationOperationError(
        "RISK_CONFIRMATION_REQUIRED",
        "Pending manual confirmation does not match the requested action"
      )
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "manual",
      "--project", "/project",
      "--session", "generation-1",
      "--action", "wait",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 1,
      failure: {
        code: "RISK_CONFIRMATION_REQUIRED",
        message: "Pending manual confirmation does not match the requested action"
      }
    });
    expect(test.observe).not.toHaveBeenCalled();
    expect(test.requestManual).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("observes authoritatively before building a manual override", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "manual",
      "--project", "/project",
      "--session", "generation-1",
      "--action", "wait",
      "--json"
    ]);

    expect(test.observe).toHaveBeenCalledWith({
      generationId: "generation-1"
    });
    expect(test.requestManual).toHaveBeenCalledWith({
      generationId: "generation-1",
      snapshot,
      manual: {
        action: "wait",
        binding: proposal.binding,
        before: snapshot.activity,
        layout: snapshot.layout
      }
    });
    expect(test.execute).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "manualOverride"
    });
  });

  it("returns the committed post-action binding and snapshot", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson)
      .mockResolvedValueOnce(runtimeConfig)
      .mockResolvedValueOnce({
        version: 1,
        proposal,
        snapshot
      });
    const nextSnapshot = {
      ...snapshot,
      baseRevision: 3,
      capturedAt: "2026-07-23T00:00:01.000Z"
    };
    const nextSnapshotHash = hashRuntimeSnapshot(nextSnapshot);
    const nextSnapshotRef = ".taphound/build/generations/generation-1/evidence/snapshots/revision-000003/attempt-3/snapshot.json";
    test.execute.mockResolvedValueOnce({
      status: "succeeded",
      step: {
        action: "wait",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      },
      nextObservation: {
        binding: {
          generationId: "generation-1",
          baseRevision: 3,
          snapshotHash: nextSnapshotHash
        },
        snapshot: nextSnapshot,
        snapshotHash: nextSnapshotHash,
        snapshotRef: nextSnapshotRef
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--session", "generation-1",
      "--input", "step.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "succeeded",
      nextBinding: {
        generationId: "generation-1",
        baseRevision: 3,
        snapshotHash: nextSnapshotHash
      },
      nextSnapshot,
      nextSnapshotRef
    });
  });

  it("returns only the committed binding and snapshotRef in compact step mode", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson)
      .mockResolvedValueOnce(runtimeConfig)
      .mockResolvedValueOnce({
        version: 1,
        proposal,
        snapshot
      });
    const nextSnapshot = {
      ...snapshot,
      baseRevision: 3,
      capturedAt: "2026-07-23T00:00:01.000Z"
    };
    const nextSnapshotHash = hashRuntimeSnapshot(nextSnapshot);
    const nextSnapshotRef = ".taphound/build/generations/generation-1/evidence/snapshots/revision-000003/attempt-3/snapshot.json";
    test.execute.mockResolvedValueOnce({
      status: "succeeded",
      step: {
        action: "wait",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      },
      nextObservation: {
        binding: {
          generationId: "generation-1",
          baseRevision: 3,
          snapshotHash: nextSnapshotHash
        },
        snapshot: nextSnapshot,
        snapshotHash: nextSnapshotHash,
        snapshotRef: nextSnapshotRef
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--session", "generation-1",
      "--input", "step.json",
      "--compact",
      "--json"
    ]);

    const output = JSON.parse(test.stdout.value) as Record<string, unknown>;
    expect(output).toMatchObject({
      status: "succeeded",
      nextBinding: {
        generationId: "generation-1",
        baseRevision: 3,
        snapshotHash: nextSnapshotHash
      },
      nextSnapshotRef
    });
    expect(output).not.toHaveProperty("nextSnapshot");
  });

  it("preflights and finalizes with exact passed tool versions", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson).mockImplementation((path) => (
      Promise.resolve(path.endsWith("context.json")
        ? generationContext
        : runtimeConfig)
    ));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "finalize",
      "--project", "/project",
      "--session", "generation-1",
      "--context", "context.json",
      "--output", ".taphound/journeys/generated.json",
      "--json"
    ]);

    expect(test.finalize).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-1",
      projectRoot: "/project",
      config: runtimeConfig,
      context: generationContext,
      outputPath: ".taphound/journeys/generated.json",
      deviceSerial: "emulator-5554",
      toolVersions: {
        node: "24.1.0",
        adb: "1.0.41",
        android: "0.2.0"
      }
    }));
    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "verified",
      exitCode: 0,
      generationId: "generation-1",
      bundlePath: "/project/.taphound/build/generations/final/generation-1",
      journeyPath: "/project/.taphound/journeys/generated.json",
      metaPath: "/project/.taphound/journeys/generated.meta.json",
      replayed: true
    });
    expect(test.dependencies.doctor.run).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissionProbe: true })
    );
  });

  it("returns durable generation status as one JSON value", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "status",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    expect(test.recoveryStatus).toHaveBeenCalledWith("generation-1");
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "inspected",
      exitCode: 0,
      generationId: "generation-1",
      recovery: { available: false }
    });
  });

  it("renders durable ownership and recovery details for human status", async () => {
    const test = harness();
    test.recoveryStatus.mockResolvedValueOnce({
      generationId: "generation-1",
      revision: 7,
      state: "active",
      candidateStepCount: 3,
      inFlight: null,
      pendingConfirmation: null,
      verification: {
        status: "running",
        attemptId: "verify-1",
        ownerPid: 4321,
        startedAt: "2026-07-23T00:00:00.000Z"
      },
      publication: { status: "notRun" },
      recovery: {
        available: false,
        kind: null,
        actionMayHaveExecuted: true,
        attemptOutcome: null,
        requiredDecision: null,
        ownerAlive: true
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "status",
      "--project", "/project",
      "--session", "generation-1"
    ]);

    expect(test.stdout.value).toContain("Generation: generation-1");
    expect(test.stdout.value).toContain("Revision: 7");
    expect(test.stdout.value).toContain("Candidate steps: 3");
    expect(test.stdout.value).toContain("Pending confirmation: none");
    expect(test.stdout.value).toContain(
      "Verification: running (attempt verify-1)"
    );
    expect(test.stdout.value).toContain(
      "Verification owner: 4321 (alive)"
    );
    expect(test.stdout.value).toContain("Recovery: unavailable");
    expect(test.stdout.value).toContain("Action may have executed: yes");
    expect(test.stderr.value).toBe("");
  });

  it("waits until generation publication is terminal", async () => {
    const test = harness();
    const base: GenerationRecoveryStatus = {
      generationId: "generation-1",
      revision: 4,
      state: "active",
      candidateStepCount: 1,
      inFlight: null,
      pendingConfirmation: null,
      verification: { status: "notRun" },
      publication: { status: "notRun" },
      recovery: {
        available: false,
        kind: null,
        actionMayHaveExecuted: false,
        attemptOutcome: null,
        requiredDecision: null,
        ownerAlive: null
      }
    };
    test.recoveryStatus
      .mockReset()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({
        ...base,
        verification: {
          status: "passed",
          attemptId: "verification-attempt"
        },
        publication: { status: "published" }
      });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "status",
      "--project", "/project",
      "--session", "generation-1",
      "--wait",
      "--timeout-ms", "1000",
      "--json"
    ]);

    expect(test.recoveryStatus).toHaveBeenCalledTimes(2);
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "inspected",
      publication: { status: "published" }
    });
  });

  it("stops waiting when dead verification ownership requires recovery", async () => {
    const test = harness();
    test.recoveryStatus.mockResolvedValueOnce({
      generationId: "generation-1",
      revision: 5,
      state: "active",
      candidateStepCount: 1,
      inFlight: null,
      pendingConfirmation: null,
      verification: {
        status: "running",
        attemptId: "verification-attempt",
        ownerPid: 4321,
        startedAt: "2026-08-22T00:00:00.000Z"
      },
      publication: { status: "notRun" },
      recovery: {
        available: true,
        kind: "verification",
        actionMayHaveExecuted: true,
        attemptOutcome: null,
        requiredDecision: "retry",
        ownerAlive: false
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "status",
      "--project", "/project",
      "--session", "generation-1",
      "--wait",
      "--timeout-ms", "1000",
      "--json"
    ]);

    expect(test.recoveryStatus).toHaveBeenCalledOnce();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "inspected",
      verification: { status: "running" },
      recovery: {
        available: true,
        kind: "verification",
        ownerAlive: false
      }
    });
  });

  it("times out while waiting without changing generation state", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "status",
      "--project", "/project",
      "--session", "generation-1",
      "--wait",
      "--timeout-ms", "1",
      "--json"
    ]);

    expect(test.retry).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "FINALIZATION_IN_PROGRESS" }
    });
  });

  it("requires explicit retry acknowledgement to recover", async () => {
    const test = harness();
    test.recoveryStatus.mockResolvedValueOnce({
      ...(await test.recoveryStatus()),
      state: "recoveryRequired",
      recovery: {
        available: true,
        kind: "step",
        actionMayHaveExecuted: true,
        attemptOutcome: "unknown",
        requiredDecision: "retry",
        ownerAlive: null
      }
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "recover",
      "--project", "/project",
      "--session", "generation-1",
      "--decision", "retry",
      "--json"
    ]);

    expect(test.retry).toHaveBeenCalledWith("generation-1");
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "recovered",
      actionMayHaveExecuted: true
    });
  });

  it("starts detached finalization without running preflight inline", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "finalize",
      "--project", "/project",
      "--session", "generation-1",
      "--context", "context.json",
      "--output", ".taphound/journeys/generated.json",
      "--detach",
      "--json"
    ]);

    expect(test.dependencies.detachedProcess?.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: process.execPath,
        cwd: "/project",
        stdoutPath: "/project/.taphound/build/jobs/generation-1/job-1-output.json"
      })
    );
    expect(test.dependencies.doctor.run).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "finalizationStarted",
      exitCode: 0,
      jobId: "job-1",
      ownerPid: 4321
    });
  });

  it("rejects an invalid detached request before spawning a child", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "finalize",
      "--project", "/project",
      "--session", "generation-1",
      "--context", "context.json",
      "--output", "../escaping.json",
      "--detach",
      "--json"
    ]);

    expect(test.dependencies.detachedProcess?.launch).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2
    });
  });

  it("rejects an escaping finalize output before environment side effects", async () => {
    const test = harness();
    vi.mocked(test.dependencies.readJson).mockImplementation((path) => (
      Promise.resolve(path.endsWith("context.json")
        ? generationContext
        : runtimeConfig)
    ));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "finalize",
      "--project", "/project",
      "--session", "generation-1",
      "--context", "context.json",
      "--output", "../escape.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2
    });
    expect(test.dependencies.doctor.run).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("archives a generation session as one JSON value", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "archive",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    expect(test.archive).toHaveBeenCalledWith("generation-1");
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "archived",
      exitCode: 0,
      generationId: "generation-1",
      revision: 5
    });
  });

  it("renders archived session for human output", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "archive",
      "--project", "/project",
      "--session", "generation-1"
    ]);

    expect(test.exitCodes[0]).toBe(0);
    expect(test.stdout.value).toContain("archived");
    expect(test.stdout.value).toContain("generation-1");
  });

  it("lists generation sessions as one JSON value", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "list",
      "--project", "/project",
      "--json"
    ]);

    expect(test.list).toHaveBeenCalledOnce();
    const output = JSON.parse(test.stdout.value) as {
      status: string;
      sessions: { id: string; state: string }[];
    };
    expect(output).toMatchObject({
      status: "listed",
      exitCode: 0
    });
    expect(output.sessions).toHaveLength(1);
    expect(output.sessions[0]).toMatchObject({
      id: "generation-1",
      state: "archived"
    });
  });

  it("renders session list for human output", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "list",
      "--project", "/project"
    ]);

    expect(test.exitCodes[0]).toBe(0);
    expect(test.stdout.value).toContain("Generation sessions");
    expect(test.stdout.value).toContain("generation-1");
  });

  it("renders empty list message when no sessions exist", async () => {
    const test = harness();
    test.list.mockResolvedValueOnce([]);

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "list",
      "--project", "/project"
    ]);

    expect(test.exitCodes[0]).toBe(0);
    expect(test.stdout.value).toContain("No generation sessions found.");
  });

  it("observes and requests confirmation for a bridge step", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "photoCapture",
      "--trigger-locator", '{"resourceId":"com.example.app:id/camera_button"}',
      "--json"
    ]);

    expect(test.observe).toHaveBeenCalledWith({
      generationId: "generation-1"
    });
    expect(test.request).toHaveBeenCalledWith({
      generationId: "generation-1",
      snapshot,
      source: "manualOverride",
      proposal: {
        action: "bridge",
        scenario: "photoCapture",
        description: "Capture photo via system camera",
        triggerLocator: { resourceId: "com.example.app:id/camera_button" },
        returnTimeoutMs: 60000,
        binding: proposal.binding,
        activity: { before: "com.example.app.MainActivity" }
      }
    });
    expect(test.execute).toHaveBeenCalledWith({
      generationId: "generation-1",
      proposal,
      snapshot,
      source: "manualOverride"
    });
    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "succeeded",
      exitCode: 0,
      generationId: "generation-1",
      revision: 4,
      stepIndex: 0,
      step: {
        action: "wait",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      },
      source: "manualOverride"
    });
  });

  it("returns confirmationRequired when bridge risk is not auto-approved", async () => {
    const test = harness();
    const challenge = {
      challengeId: "bridge-challenge-1",
      stepIndex: 1,
      proposalHash: "abc",
      snapshotHash: proposal.binding.snapshotHash,
      evidenceHash: "def",
      actionSummary: "Bridge photoCapture via {\"resourceId\":\"com.example.app:id/camera_button\"} on com.example.app.MainActivity",
      expiresAt: "2026-07-23T00:05:00.000Z",
      status: "pending" as const
    };
    test.request.mockResolvedValueOnce({
      status: "confirmationRequired" as const,
      revision: 5,
      challenge
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "photoCapture",
      "--trigger-locator", '{"resourceId":"com.example.app:id/camera_button"}',
      "--json"
    ]);

    expect(test.execute).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "confirmationRequired",
      exitCode: 0,
      generationId: "generation-1",
      revision: 5,
      challenge
    });
  });

  it("returns an existing pending confirmation before observing", async () => {
    const test = harness();
    const challenge = {
      challengeId: "pending-bridge-1",
      stepIndex: 0,
      proposalHash: "abc",
      snapshotHash: "def",
      evidenceHash: "ghi",
      actionSummary: "Bridge photoCapture via ...",
      expiresAt: "2026-07-23T00:05:00.000Z",
      status: "pending" as const
    };
    test.dependencies.readJson = vi.fn(() => Promise.resolve(runtimeConfig));
    const generationRuntime = test.dependencies.generationRuntime as Mock;
    generationRuntime.mockReturnValueOnce({
      confirmation: {
        request: test.request,
        requestManual: test.requestManual,
        confirmStored: test.confirmStored,
        findPendingManual: test.findPendingManual
      },
      executor: { execute: test.execute },
      observer: { observe: test.observe },
      finalizer: { finalize: test.finalize },
      recovery: { status: test.recoveryStatus, retry: test.retry },
      archive: test.archive,
      list: test.list,
      readSession: vi.fn(() => Promise.resolve({
        revision: 5,
        candidateSteps: [],
        contextSelection,
        pendingConfirmation: challenge
      })),
      assertConfigIdentity: test.assertConfigIdentity
    });

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "photoCapture",
      "--trigger-locator", '{"resourceId":"com.example.app:id/camera_button"}',
      "--json"
    ]);

    expect(test.observe).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "confirmationRequired",
      exitCode: 0,
      generationId: "generation-1",
      revision: 5,
      challenge
    });
  });

  it("requires --description for custom scenario", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "custom",
      "--trigger-locator", '{"resourceId":"com.example.app:id/button"}',
      "--json"
    ]);

    expect(test.observe).not.toHaveBeenCalled();
    const output = JSON.parse(test.stdout.value) as {
      failure: { code: string };
      exitCode: number;
    };
    expect(output.failure.code).toBe("CONTEXT_INVALID");
    expect(output.exitCode).toBe(2);
  });

  it("accepts explicit --description for custom scenario", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "custom",
      "--description", "Open external PDF viewer",
      "--trigger-locator", '{"resourceId":"com.example.app:id/pdf_button"}',
      "--json"
    ]);

    expect(test.request).toHaveBeenCalledWith({
      generationId: "generation-1",
      snapshot,
      source: "manualOverride",
      proposal: {
        action: "bridge",
        scenario: "custom",
        description: "Open external PDF viewer",
        triggerLocator: { resourceId: "com.example.app:id/pdf_button" },
        returnTimeoutMs: 60000,
        binding: proposal.binding,
        activity: { before: "com.example.app.MainActivity" }
      }
    });
  });

  it("rejects an invalid scenario with exit code 2", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "invalidScenario",
      "--trigger-locator", '{"resourceId":"com.example.app:id/button"}',
      "--json"
    ]);

    expect(test.observe).not.toHaveBeenCalled();
    const output = JSON.parse(test.stdout.value) as {
      failure: { code: string };
      exitCode: number;
    };
    expect(output.failure.code).toBe("CONTEXT_INVALID");
    expect(output.exitCode).toBe(2);
  });

  it("rejects malformed trigger-locator JSON with exit code 2", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "photoCapture",
      "--trigger-locator", "not-json",
      "--json"
    ]);

    expect(test.observe).not.toHaveBeenCalled();
    const output = JSON.parse(test.stdout.value) as {
      failure: { code: string };
      exitCode: number;
    };
    expect(output.failure.code).toBe("CONTEXT_INVALID");
    expect(output.exitCode).toBe(2);
  });

  it("rejects non-positive return-timeout-ms with exit code 2", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "photoCapture",
      "--trigger-locator", '{"resourceId":"com.example.app:id/button"}',
      "--return-timeout-ms", "0",
      "--json"
    ]);

    expect(test.observe).not.toHaveBeenCalled();
    const output = JSON.parse(test.stdout.value) as {
      failure: { code: string };
      exitCode: number;
    };
    expect(output.failure.code).toBe("CONTEXT_INVALID");
    expect(output.exitCode).toBe(2);
  });

  it("passes custom return-timeout-ms to the proposal", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "generation", "bridge",
      "--project", "/project",
      "--session", "generation-1",
      "--scenario", "pickImage",
      "--trigger-locator", '{"resourceId":"com.example.app:id/gallery_button"}',
      "--return-timeout-ms", "120000",
      "--json"
    ]);

    expect(test.request).toHaveBeenCalledWith({
      generationId: "generation-1",
      snapshot,
      source: "manualOverride",
      proposal: {
        action: "bridge",
        scenario: "pickImage",
        description: "Pick image via system picker",
        triggerLocator: { resourceId: "com.example.app:id/gallery_button" },
        returnTimeoutMs: 120000,
        binding: proposal.binding,
        activity: { before: "com.example.app.MainActivity" }
      }
    });
  });
});
