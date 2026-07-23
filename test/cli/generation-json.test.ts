import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  ConfirmationRequestResult
} from "../../src/application/generation/generation-confirmation-service.js";
import {
  GenerationOperationError
} from "../../src/application/generation/generation-starter.js";
import { createProgram } from "../../src/cli/program.js";
import type {
  CliDependencies,
  TextOutput
} from "../../src/cli/dependencies.js";
import {
  createProductionDependencies
} from "../../src/cli/dependencies.js";
import { hashRuntimeSnapshot } from "../../src/domain/runtime-snapshot.js";
import { runtimeConfig } from "../fakes/runtime-fixture.js";

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

const generationContext = {
  version: 1 as const,
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity",
  manifest: {
    version: 1 as const,
    files: [{
      path: "AndroidManifest.xml",
      sha256: "a".repeat(64),
      confidence: "sourceConfirmed" as const
    }]
  },
  interactionPolicy: {
    allowedActions: ["wait" as const],
    confirmationRequiredActions: [],
    forbiddenActions: []
  }
};

interface Harness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  request: Mock<() => Promise<ConfirmationRequestResult>>;
  execute: Mock;
  confirmStored: Mock;
  requestManual: Mock;
  observe: Mock;
  finalize: Mock;
}

function harness(): Harness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
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
    bundlePath: "/project/.taphound/generations/final/generation-1",
    journeyPath: "/project/journeys/generated.json",
    metaPath: "/project/journeys/generated.meta.json",
    replayed: true
  }));
  const readSession = vi.fn(() => Promise.resolve({
    revision: 4,
    candidateSteps: [{}]
  }));
  const dependencies = {
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
        buildTask: ":app:assembleDebug",
        artifactTarget: "app",
        variant: "debug",
        launchActivity: "com.example.app.MainActivity",
        apkPath: "/project/app-debug.apk",
        metadataPaths: []
      }))
    },
    contextValidator: { validate: vi.fn() },
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
    generationRuntime: vi.fn(() => ({
      confirmation: { request, requestManual, confirmStored },
      executor: { execute },
      observer: { observe },
      finalizer: { finalize },
      readSession
    })),
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
    requestManual,
    observe,
    finalize
  };
}

describe("generation JSON process protocol", () => {
  it("composes all production generation services per invocation", () => {
    const dependencies = createProductionDependencies();
    const runtime = dependencies.generationRuntime?.({
      projectRoot: "/project",
      config: runtimeConfig
    });

    expect(runtime).toBeDefined();
    expect(runtime?.confirmation.request).toBeTypeOf("function");
    expect(runtime?.confirmation.confirmStored).toBeTypeOf("function");
    expect(runtime?.executor.execute).toBeTypeOf("function");
    expect(runtime?.observer.observe).toBeTypeOf("function");
    expect(runtime?.finalizer.finalize).toBeTypeOf("function");
    expect(runtime?.readSession).toBeTypeOf("function");
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

  it("returns confirmationRequired without executing an action", async () => {
    const test = harness();
    test.request.mockResolvedValueOnce({
      status: "confirmationRequired",
      challenge: {
        challengeId: "challenge-1",
        stepIndex: 0,
        proposalHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
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

  it.each([
    ["SNAPSHOT_STALE" as const, "stale snapshot"],
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

  it("maps step failure and cancellation to one exit-1 JSON result", async () => {
    const failed = harness();
    failed.execute.mockResolvedValueOnce({
      status: "failed",
      failure: { code: "ACTION_FAILED", message: "adb failed" }
    });
    await createProgram(failed.dependencies).parseAsync([
      "node", "taphound", "generation", "step",
      "--project", "/project",
      "--input", "input.json",
      "--session", "generation-1",
      "--json"
    ]);
    expect(JSON.parse(failed.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 1,
      failure: { code: "ACTION_FAILED" }
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
      status: "error",
      exitCode: 1,
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
      "--output", "journeys/generated.json",
      "--json"
    ]);

    expect(test.finalize).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-1",
      projectRoot: "/project",
      config: runtimeConfig,
      context: generationContext,
      outputPath: "journeys/generated.json",
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
      bundlePath: "/project/.taphound/generations/final/generation-1",
      journeyPath: "/project/journeys/generated.json",
      metaPath: "/project/journeys/generated.meta.json",
      replayed: true
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
});
