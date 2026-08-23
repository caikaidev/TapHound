import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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
  FileSystemGenerationMetaWriter
} from "../../../src/adapters/filesystem/generation-meta-writer.js";
import {
  FileSystemGenerationSessionStore,
  type FileSystemGenerationSessionStoreOptions
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  FileSystemJourneyWriter
} from "../../../src/adapters/filesystem/journey-writer.js";
import {
  GenerationFinalizer,
  GenerationOutputPathSchema
} from "../../../src/application/generation/generation-finalizer.js";
import {
  GenerationPublisher
} from "../../../src/application/generation/generation-publisher.js";
import {
  hashGenerationBinding
} from "../../../src/application/generation/generation-starter.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type {
  GenerationSession
} from "../../../src/domain/generation.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";
import type {
  ResolvedProjectContext
} from "../../../src/domain/project-context.js";
import {
  hashJourney,
  type TapHoundReport
} from "../../../src/domain/report.js";
import type {
  ProjectBoundGenerationMetaWriterPort
} from "../../../src/ports/generation-meta-writer.js";
import type {
  ProjectBoundJourneyWriterPort
} from "../../../src/ports/journey-writer.js";
import type {
  AppIdentity
} from "../../../src/ports/adb.js";
import type {
  CommandResult
} from "../../../src/ports/process-runner.js";
import type {
  VerifyInput,
  VerifyResult
} from "../../../src/application/runtime/verify-runtime.js";
import { commandResult } from "../../fakes/process-runner.js";
import { contextSelection } from "../../fixtures/project-context.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const config: TapHoundConfig = {
  version: 1,
  run: { packageName: "com.example.app", activity: ".MainActivity" },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 100,
    stablePolls: 2,
    timeoutMs: 5_000
  },
  artifactsDir: ".taphound/build/reports"
};

const context: ResolvedProjectContext = {
  version: 2,
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity",
  manifest: {
    version: 1,
    files: [{
      path: "app/src/main/AndroidManifest.xml",
      sha256: "a".repeat(64),
      confidence: "sourceConfirmed"
    }]
  },
  interactionPolicy: {
    allowedActions: ["inputText", "wait"],
    confirmationRequiredActions: [],
    forbiddenActions: ["back"]
  },
  selection: contextSelection
};

function project(root: string): {
  projectRoot: string;
  packageName: string;
  launchActivity: string;
} {
  return {
    projectRoot: root,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity"
  };
}

function report(root: string, fallbackUsed = false): TapHoundReport {
  const journey = {
    version: 1 as const,
    name: "generated",
    steps: [{
      action: "wait" as const,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      },
      expect: {
        type: "activity" as const,
        value: "com.example.app.MainActivity",
        timeoutMs: 100
      }
    }]
  };
  return {
    schemaVersion: 2,
    runId: "verify-run",
    status: "passed",
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    durationMs: 1_000,
    project: {
      root,
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "generated", sha256: hashJourney(journey) },
    environment: {
      deviceSerial: "emulator-5554",
      tools: { adb: "1" }
    },
    layers: {
      run: "passed",
      structural: "passed",
      activityCheckpoint: "passed",
      explicitExpect: "passed",
      collection: "passed"
    },
    steps: [{
      index: 0,
      action: "wait",
      status: "passed",
      startedAtMs: 0,
      finishedAtMs: 1,
      durationMs: 1,
      idle: {
        status: "stable",
        polls: 1
      },
      activity: {
        before: {
          status: "passed",
          expected: "com.example.app.MainActivity",
          actual: "com.example.app.MainActivity"
        },
        after: {
          status: "passed",
          expected: "com.example.app.MainActivity",
          actual: "com.example.app.MainActivity"
        }
      },
      expectation: {
        type: "activity",
        status: "passed"
      }
    }],
    artifacts: {
      directory: "/reports/verify-run",
      report: "report.json",
      summary: "summary.txt",
      stepLogs: []
    },
    secondaryErrors: [],
    fallbackUsed
  };
}

function bridgeReport(root: string): TapHoundReport {
  const journey = {
    version: 1 as const,
    name: "generated",
    steps: [{
      action: "bridge" as const,
      scenario: "photoCapture" as const,
      description: "Open camera to take a photo",
      triggerLocator: { resourceId: "camera-button" },
      returnTimeoutMs: 10000,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.ImageEditActivity"
      },
      replayMode: "manual" as const
    }]
  };
  return {
    schemaVersion: 2,
    runId: "verify-run",
    status: "passed",
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    durationMs: 1_000,
    project: {
      root,
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "generated", sha256: hashJourney(journey) },
    environment: {
      deviceSerial: "emulator-5554",
      tools: { adb: "1" }
    },
    layers: {
      run: "passed",
      structural: "passed",
      activityCheckpoint: "passed",
      explicitExpect: "passed",
      collection: "passed"
    },
    steps: [{
      index: 0,
      action: "bridge",
      status: "passed",
      replayMode: "manual",
      startedAtMs: 0,
      finishedAtMs: 1,
      durationMs: 1,
      locator: {
        status: "found",
        matchedBy: "resourceId",
        fallbackUsed: false
      },
      idle: {
        status: "stable",
        polls: 1
      },
      activity: {
        before: {
          status: "passed",
          expected: "com.example.app.MainActivity",
          actual: "com.example.app.MainActivity"
        },
        after: {
          status: "passed",
          expected: "com.example.app.ImageEditActivity",
          actual: "com.example.app.ImageEditActivity"
        }
      }
    }],
    artifacts: {
      directory: "/reports/verify-run",
      report: "report.json",
      summary: "summary.txt",
      stepLogs: []
    },
    secondaryErrors: [],
    fallbackUsed: false
  };
}

function session(root: string): GenerationSession {
  const description = project(root);
  return {
    version: 1,
    id: "generation-1",
    revision: 0,
    state: "active",
    bindings: {
      projectHash: hashGenerationBinding(description),
      configHash: hashGenerationBinding(config),
      contextHash: hashGenerationBinding(context),
      snapshotHash: "c".repeat(64)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: context.interactionPolicy
    },
    contextSelection,
    variables: {
      runId: "candidate-run",
      timestamp: "2026-07-23T00:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [{
      action: "wait",
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      },
      expect: {
        type: "activity",
        value: "com.example.app.MainActivity",
        timeoutMs: 100
      }
    }],
    candidateSources: ["manualOverride"],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

function sessionWithBridge(root: string): GenerationSession {
  const base = session(root);
  return {
    ...base,
    candidateSteps: [{
      action: "bridge",
      scenario: "photoCapture",
      description: "Open camera to take a photo",
      triggerLocator: { resourceId: "camera-button" },
      returnTimeoutMs: 10000,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.ImageEditActivity"
      },
      replayMode: "manual"
    }]
  };
}

async function bridgeFixture(
  metaWriter: ProjectBoundGenerationMetaWriterPort = (
    new FileSystemGenerationMetaWriter()
  ),
  journeyWriter: ProjectBoundJourneyWriterPort = new FileSystemJourneyWriter()
): Promise<FinalizerFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-finalizer-"));
  const canonicalRoot = await realpath(root);
  roots.push(root);
  const store = new FileSystemGenerationSessionStore(root);
  await store.create(sessionWithBridge(root));
  const verify = vi.fn<VerifyFunction>(() => Promise.resolve({
    status: "passed" as const,
    exitCode: 0 as const,
    report: bridgeReport(canonicalRoot),
    reportPath: "/reports/report.json",
    summaryPath: "/reports/summary.txt"
  }));
  const forceStop = vi.fn<ForceStopFunction>(
    () => Promise.resolve(commandResult())
  );
  const validateContext = vi.fn(
    () => Promise.resolve({ status: "valid" as const })
  );
  const publisher = new GenerationPublisher({
    store,
    journeyWriter,
    metaWriter
  });
  return {
    root,
    canonicalRoot,
    store,
    verify,
    forceStop,
    finalize: new GenerationFinalizer({
      store,
      contextValidator: { validate: validateContext },
      verifyRuntime: { verify },
      publisher,
      generateAttemptId: (): string => "verification-attempt"
    }),
    validateContext
  };
}

type VerifyFunction = (input: VerifyInput) => Promise<VerifyResult>;
type ForceStopFunction = (identity: AppIdentity) => Promise<CommandResult>;

interface FinalizerFixture {
  root: string;
  canonicalRoot: string;
  store: FileSystemGenerationSessionStore;
  finalize: GenerationFinalizer;
  verify: Mock<VerifyFunction>;
  forceStop: Mock<ForceStopFunction>;
  validateContext: Mock<() => Promise<
    | { status: "valid" }
    | {
        status: "stale";
        reason: {
          code: "EVIDENCE_HASH_MISMATCH";
          message: string;
        };
      }
  >>;
}

async function fixture(
  metaWriter: ProjectBoundGenerationMetaWriterPort = (
    new FileSystemGenerationMetaWriter()
  ),
  journeyWriter: ProjectBoundJourneyWriterPort = new FileSystemJourneyWriter(),
  storeOptions: FileSystemGenerationSessionStoreOptions = {}
): Promise<FinalizerFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-finalizer-"));
  const canonicalRoot = await realpath(root);
  roots.push(root);
  const store = new FileSystemGenerationSessionStore(root, storeOptions);
  await store.create(session(root));
  const verify = vi.fn<VerifyFunction>(() => Promise.resolve({
    status: "passed" as const,
    exitCode: 0 as const,
    report: report(canonicalRoot),
    reportPath: "/reports/report.json",
    summaryPath: "/reports/summary.txt"
  }));
  const forceStop = vi.fn<ForceStopFunction>(
    () => Promise.resolve(commandResult())
  );
  const validateContext = vi.fn(
    () => Promise.resolve({ status: "valid" as const })
  );
  const publisher = new GenerationPublisher({
    store,
    journeyWriter,
    metaWriter
  });
  return {
    root,
    canonicalRoot,
    store,
    verify,
    forceStop,
    finalize: new GenerationFinalizer({
      store,
      contextValidator: {
        validate: validateContext
      },
      verifyRuntime: { verify },
      publisher,
      generateAttemptId: (): string => "verification-attempt"
    }),
    validateContext
  };
}

function input(root: string): {
  generationId: string;
  projectRoot: string;
  config: TapHoundConfig;
  context: ResolvedProjectContext;
  project: ReturnType<typeof project>;
  outputPath: string;
  deviceSerial: string;
  toolVersions: Record<string, string>;
} {
  return {
    generationId: "generation-1",
    projectRoot: root,
    config,
    context,
    project: project(root),
    outputPath: ".taphound/journeys/generated.json",
    deviceSerial: "emulator-5554",
    toolVersions: { adb: "1" }
  };
}

async function writeCrashRecoveryEvidence(
  test: FinalizerFixture
): Promise<void> {
  const running = await test.store.beginVerification(
    "generation-1",
    0,
    "verification-attempt"
  );
  const verificationReport = report(test.canonicalRoot);
  const reportBytes = `${JSON.stringify(verificationReport, null, 2)}\n`;
  await test.store.writeTextEvidence(
    "generation-1",
    "verification/report.json",
    reportBytes
  );
  await test.store.writeTextEvidence(
    "generation-1",
    "verification/receipt.json",
    `${JSON.stringify({
      version: 1,
      generationId: "generation-1",
      attemptId: "verification-attempt",
      journey: verificationReport.journey,
      project: {
        root: test.canonicalRoot,
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      },
      deviceSerial: "emulator-5554",
      bindings: running.bindings,
      tools: { adb: "1" },
      report: {
        path: "verification/report.json",
        sha256: sha256(reportBytes),
        runId: verificationReport.runId
      }
    }, null, 2)}\n`
  );
}

describe("GenerationFinalizer", () => {
  it("replays exactly once and publishes a verified immutable bundle", async () => {
    const test = await fixture();
    await test.store.writeEvidence(
      "generation-1",
      "evidence/runtime-observation.json",
      { captured: true }
    );

    const result = await test.finalize.finalize(input(test.root));

    expect(result.status).toBe("verified");
    expect(result.replayed).toBe(true);
    expect(result.journey.name).toBe("generated");
    expect(result.meta.manualOverrideStepIndexes).toEqual([0]);
    expect(test.forceStop).not.toHaveBeenCalled();
    expect(test.verify).toHaveBeenCalledOnce();
    expect(test.verify).toHaveBeenCalledWith(expect.objectContaining({
      requireFocusedInput: true
    }));
    const manifest = JSON.parse(await readFile(join(
      test.root,
      ".taphound/build/generations/generation-1/manifest.json"
    ), "utf8")) as { files: { path: string }[] };
    expect(manifest.files.map((file) => file.path)).toEqual([
      "candidate/journey.json",
      "evidence/runtime-observation.json",
      "generation-report.json",
      "meta.json",
      "verification/receipt.json",
      "verification/report.json",
      "verified/journey.json"
    ]);
    await expect(readFile(
      join(test.root, ".taphound/journeys/generated.json"),
      "utf8"
    )).resolves.toContain('"version": 1');
    await expect(readFile(
      join(test.root, ".taphound/journeys/generated.meta.json"),
      "utf8"
    )).resolves.toContain('"status": "verified"');
  });

  it("does not create a manifest or publish a racing evidence snapshot", async () => {
    let candidatePath = "";
    let mutate = true;
    const test = await fixture(undefined, undefined, {
      hooks: {
        afterEvidenceRead: async (path): Promise<void> => {
          if (mutate && path === "candidate/journey.json") {
            mutate = false;
            await writeFile(candidatePath, "mutated", "utf8");
          }
        }
      }
    });
    candidatePath = join(
      test.root,
      ".taphound/build/generations/.generation-1.work/candidate/journey.json"
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toBeInstanceOf(
      Error
    );
    await expect(readFile(join(
      test.root,
      ".taphound/build/generations/.generation-1.work/manifest.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(
      test.root,
      ".taphound/build/generations/generation-1/manifest.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a failed meta export without replaying verification", async () => {
    const failingMeta = new FileSystemGenerationMetaWriter({
      beforeBoundInstall: (): never => {
        throw new Error("disk full");
      }
    });
    const test = await fixture(failingMeta);

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED",
      stage: "export",
      recoverable: true
    });
    expect(test.verify).toHaveBeenCalledOnce();
    const retry = new GenerationFinalizer({
      store: test.store,
      contextValidator: {
        validate: vi.fn(
          () => Promise.resolve({ status: "valid" as const })
        )
      },
      verifyRuntime: { verify: test.verify },
      publisher: new GenerationPublisher({
        store: test.store,
        journeyWriter: new FileSystemJourneyWriter(),
        metaWriter: new FileSystemGenerationMetaWriter()
      }),
      generateAttemptId: (): string => "must-not-run"
    });

    const result = await retry.finalize(input(test.root));

    expect(result.replayed).toBe(false);
    expect(test.verify).toHaveBeenCalledOnce();
    expect(test.forceStop).not.toHaveBeenCalled();
  });

  it("rejects fallback verification and durably prevents replay", async () => {
    const test = await fixture();
    test.verify.mockResolvedValue({
      status: "passed",
      exitCode: 0,
      report: report(test.canonicalRoot, true),
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    });

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("does not let a concurrent finalizer start a second replay", async () => {
    const test = await fixture();
    let release: (() => void) | undefined;
    test.verify.mockImplementation(() => new Promise((resolve) => {
      release = (): void => {
        resolve({
          status: "passed",
          exitCode: 0,
          report: report(test.canonicalRoot),
          reportPath: "/reports/report.json",
          summaryPath: "/reports/summary.txt"
        });
      };
    }));
    const first = test.finalize.finalize(input(test.root));
    await vi.waitFor((): void => {
      expect(test.verify).toHaveBeenCalledOnce();
    });

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "FINALIZATION_IN_PROGRESS"
    });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "verified" });
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("revalidates current manifest sources before recovering a crash receipt", async () => {
    const test = await fixture();
    const manifestPath = join(
      test.root,
      "app/src/main/AndroidManifest.xml"
    );
    await mkdir(join(test.root, "app/src/main"), { recursive: true });
    await writeFile(manifestPath, "original", "utf8");
    test.validateContext.mockImplementation(async () => (
      await readFile(manifestPath, "utf8") === "original"
        ? { status: "valid" as const }
        : {
            status: "stale" as const,
            reason: {
              code: "EVIDENCE_HASH_MISMATCH" as const,
              message: "manifest source changed"
            }
          }
    ));
    await writeCrashRecoveryEvidence(test);
    await writeFile(manifestPath, "changed after replay crash", "utf8");

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: {
        status: "failed",
        failure: { code: "CONTEXT_STALE" }
      }
    });
    expect(test.verify).not.toHaveBeenCalled();
    expect(test.validateContext).toHaveBeenCalledOnce();
  });

  it("leaves a running attempt in progress when its receipt is truly absent", async () => {
    const test = await fixture();
    await test.store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "FINALIZATION_IN_PROGRESS"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "running" }
    });
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("durably fails a running attempt whose receipt parent is substituted", async () => {
    const test = await fixture();
    await writeCrashRecoveryEvidence(test);
    const workRoot = join(
      test.root,
      ".taphound/build/generations/.generation-1.work"
    );
    const outside = await mkdtemp(join(tmpdir(), "taphound-receipt-outside-"));
    roots.push(outside);
    await rename(
      join(workRoot, "verification"),
      join(workRoot, "verification-moved")
    );
    await symlink(outside, join(workRoot, "verification"));

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("durably fails a running attempt with malformed receipt JSON", async () => {
    const test = await fixture();
    await test.store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );
    await test.store.writeTextEvidence(
      "generation-1",
      "verification/receipt.json",
      "{not-json"
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
  });

  it("durably fails a running attempt on non-missing receipt I/O errors", async () => {
    const test = await fixture();
    await test.store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );
    vi.spyOn(test.store, "readEvidence").mockRejectedValueOnce(
      new GenerationSessionStoreError(
        "IO_ERROR",
        "permission denied while reading receipt"
      )
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("does not fail a different running attempt during recovery", async () => {
    const test = await fixture();
    const running = await test.store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );
    vi.spyOn(test.store, "read")
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({
        ...running,
        verification: {
          status: "running",
          attemptId: "replacement-attempt"
        }
      });
    vi.spyOn(test.store, "readEvidence").mockRejectedValueOnce(
      new GenerationSessionStoreError(
        "IO_ERROR",
        "permission denied while reading receipt"
      )
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: {
        status: "running",
        attemptId: "verification-attempt"
      }
    });
  });

  it.each([
    ["generation", (receipt: Record<string, unknown>): void => {
      receipt.generationId = "other-generation";
    }],
    ["Context binding", (receipt: Record<string, unknown>): void => {
      const bindings = receipt.bindings as Record<string, unknown>;
      bindings.contextHash = "9".repeat(64);
    }]
  ] as const)("fails closed on a cross-bound %s receipt", async (
    _description,
    mutate
  ) => {
    const test = await fixture();
    const running = await test.store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );
    const verificationReport = report(test.canonicalRoot);
    const reportBytes = `${JSON.stringify(verificationReport, null, 2)}\n`;
    await test.store.writeTextEvidence(
      "generation-1",
      "verification/report.json",
      reportBytes
    );
    const receipt: Record<string, unknown> = {
      version: 1,
      generationId: "generation-1",
      attemptId: "verification-attempt",
      journey: verificationReport.journey,
      project: {
        root: test.canonicalRoot,
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      },
      deviceSerial: "emulator-5554",
      bindings: {
        projectHash: running.bindings.projectHash,
        configHash: running.bindings.configHash,
        contextHash: running.bindings.contextHash,
        snapshotHash: running.bindings.snapshotHash
      },
      tools: { adb: "1" },
      report: {
        path: "verification/report.json",
        sha256: sha256(reportBytes),
        runId: verificationReport.runId
      }
    };
    mutate(receipt);
    await test.store.writeTextEvidence(
      "generation-1",
      "verification/receipt.json",
      `${JSON.stringify(receipt, null, 2)}\n`
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("rejects changed project bindings before process reset", async () => {
    const test = await fixture();
    const changed = input(test.root);
    changed.project = {
      ...changed.project,
      launchActivity: "com.example.app.OtherActivity"
    };

    await expect(test.finalize.finalize(changed)).rejects.toMatchObject({
      code: "CONTEXT_STALE",
      stage: "precondition"
    });
    expect(test.forceStop).not.toHaveBeenCalled();
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("fails verification when Context changes after replay", async () => {
    const test = await fixture();
    test.validateContext
      .mockResolvedValueOnce({ status: "valid" })
      .mockResolvedValueOnce({
        status: "stale",
        reason: {
          code: "EVIDENCE_HASH_MISMATCH",
          message: "context changed"
        }
      });

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "CONTEXT_STALE"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
  });
  it("allows post-replay evidence drift only with explicit opt-in", async () => {
    const test = await fixture();
    test.validateContext
      .mockResolvedValueOnce({ status: "valid" })
      .mockResolvedValueOnce({
        status: "stale",
        reason: {
          code: "EVIDENCE_HASH_MISMATCH",
          message: "implementation-only source change"
        }
      });

    await expect(test.finalize.finalize({
      ...input(test.root),
      allowEvidenceDrift: true
    })).resolves.toMatchObject({
      status: "verified",
      replayed: true
    });
  });

  it.each([
    ["Journey", (value: TapHoundReport): void => {
      value.journey.name = "other";
    }],
    ["project root", (value: TapHoundReport): void => {
      value.project.root = "/other";
    }],
    ["package", (value: TapHoundReport): void => {
      value.project.packageName = "com.other.app";
    }],
    ["launch Activity", (value: TapHoundReport): void => {
      value.project.launchActivity = "com.example.app.OtherActivity";
    }],
    ["device", (value: TapHoundReport): void => {
      value.environment.deviceSerial = "other-device";
    }],
    ["tools", (value: TapHoundReport): void => {
      value.environment.tools = { adb: "different" };
    }],
    ["layer", (value: TapHoundReport): void => {
      value.layers.collection = "failed";
    }],
    ["step action", (value: TapHoundReport): void => {
      const step = value.steps[0];
      if (step !== undefined) step.action = "back";
    }],
    ["step status", (value: TapHoundReport): void => {
      const step = value.steps[0];
      if (step !== undefined) step.status = "failed";
    }],
    ["step Activity", (value: TapHoundReport): void => {
      const step = value.steps[0];
      if (step?.activity !== undefined) {
        step.activity.after.actual = "com.example.app.OtherActivity";
      }
    }],
    ["expectation", (value: TapHoundReport): void => {
      const step = value.steps[0];
      if (step?.expectation !== undefined) {
        step.expectation.status = "failed";
      }
    }],
    ["secondary errors", (value: TapHoundReport): void => {
      value.secondaryErrors.push({
        code: "COLLECTION_FAILED",
        message: "late collection failure",
        phase: "collection"
      });
    }],
    ["primary failure", (value: TapHoundReport): void => {
      value.primaryFailure = {
        code: "ACTION_FAILED",
        message: "unexpected primary failure",
        phase: "replay",
        stepIndex: 0
      };
    }],
    ["fallback", (value: TapHoundReport): void => {
      value.fallbackUsed = true;
    }]
  ] as const)("never passes a report with mismatched %s", async (
    _description,
    mutate
  ) => {
    const test = await fixture();
    const mismatched = structuredClone(report(test.canonicalRoot));
    mutate(mismatched);
    test.verify.mockResolvedValue({
      status: "passed",
      exitCode: 0,
      report: mismatched,
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    });

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    await expect(test.store.read("generation-1")).resolves.toMatchObject({
      verification: { status: "failed" }
    });
  });

  it("rejects output paths that overlap the authoritative generation bundle", async () => {
    const test = await fixture();
    const invalid = input(test.root);
    invalid.outputPath = ".taphound/build/generations/generation-1/journey.json";

    await expect(test.finalize.finalize(invalid)).rejects.toThrow(
      /authoritative bundle/i
    );
    expect(test.forceStop).not.toHaveBeenCalled();
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("accepts committed Journey outputs and rejects the build subtree", () => {
    expect(
      GenerationOutputPathSchema.parse(".taphound/journeys/x.json")
    ).toBe(".taphound/journeys/x.json");
    expect(GenerationOutputPathSchema.parse("journeys/x.json")).toBe(
      "journeys/x.json"
    );
    for (const invalid of [
      ".taphound/build",
      ".taphound/build/runs/x.json",
      ".taphound/build/generations/generation-1/journey.json"
    ]) {
      expect(() => GenerationOutputPathSchema.parse(invalid)).toThrow(
        /authoritative bundle/i
      );
    }
  });

  it("cannot export a different Journey identity after verification", async () => {
    const test = await fixture();
    await test.finalize.finalize(input(test.root));

    await expect(test.finalize.finalize({
      ...input(test.root),
      name: "different"
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      stage: "verification"
    });
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("does not export through a parent symlink outside the project", async () => {
    const test = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "taphound-export-outside-"));
    roots.push(outside);
    await symlink(outside, join(test.root, ".taphound/journeys"));

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    await expect(readdir(outside)).resolves.toEqual([]);
    const manifestPath = join(
      test.root,
      ".taphound/build/generations/generation-1/manifest.json"
    );
    const manifest = await readFile(manifestPath, "utf8");
    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifest);
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("does not export through an alias into the authority bundle", async () => {
    const test = await fixture();
    await symlink(
      join(test.root, ".taphound/build/generations/generation-1"),
      join(test.root, ".taphound/journeys")
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    await expect(readFile(join(
      test.root,
      ".taphound/build/generations/generation-1/manifest.json"
    ), "utf8")).resolves.toContain('"generationId": "generation-1"');
  });

  it("does not follow Journey or meta destination symlinks", async () => {
    const test = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "taphound-export-outside-"));
    roots.push(outside);
    await mkdir(join(test.root, ".taphound/journeys"));
    const victim = join(outside, "victim.json");
    await writeFile(victim, "unchanged", "utf8");
    await symlink(victim, join(test.root, ".taphound/journeys/generated.meta.json"));

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
    await expect(readFile(
      join(test.root, ".taphound/journeys/generated.json"),
      "utf8"
    )).resolves.toContain('"version": 1');
  });

  it("detects authority mutation immediately after Journey export", async () => {
    const base = new FileSystemJourneyWriter();
    const mutatingWriter = {
      write: base.write.bind(base),
      readProjectBound: base.readProjectBound.bind(base),
      writeProjectBound: async (
        bound: Parameters<typeof base.writeProjectBound>[0]
      ): Promise<void> => {
        await base.writeProjectBound(bound);
        await writeFile(
          join(
            bound.authorityRoot,
            "generations/generation-1/manifest.json"
          ),
          "mutated",
          "utf8"
        );
      }
    } satisfies ProjectBoundJourneyWriterPort;
    const test = await fixture(
      new FileSystemGenerationMetaWriter(),
      mutatingWriter
    );

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("detects authority mutation immediately after meta export", async () => {
    const base = new FileSystemGenerationMetaWriter();
    const mutatingWriter = {
      write: base.write.bind(base),
      readProjectBound: base.readProjectBound.bind(base),
      writeProjectBound: async (
        bound: Parameters<typeof base.writeProjectBound>[0]
      ): Promise<void> => {
        await base.writeProjectBound(bound);
        await writeFile(
          join(
            bound.authorityRoot,
            "generations/generation-1/manifest.json"
          ),
          "mutated",
          "utf8"
        );
      }
    } satisfies ProjectBoundGenerationMetaWriterPort;
    const test = await fixture(mutatingWriter);

    await expect(test.finalize.finalize(input(test.root))).rejects.toMatchObject({
      code: "EXPORT_FAILED"
    });
    expect(test.verify).toHaveBeenCalledOnce();
  });

  it("refuses non-interactive finalization when the Journey contains manual steps", async () => {
    const test = await bridgeFixture();
    const finalizeInput = input(test.root);
    (finalizeInput as { manualReplay?: boolean }).manualReplay = false;

    await expect(test.finalize.finalize(finalizeInput)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      stage: "verification"
    });
    expect(test.verify).not.toHaveBeenCalled();
    expect(test.forceStop).not.toHaveBeenCalled();
  });

  it("proceeds with interactive finalization when the Journey contains manual steps", async () => {
    const test = await bridgeFixture();
    const finalizeInput = input(test.root);
    (finalizeInput as { manualReplay?: boolean }).manualReplay = true;

    const result = await test.finalize.finalize(finalizeInput);

    expect(result.status).toBe("verified");
    expect(test.verify).toHaveBeenCalledOnce();
    expect(test.verify).toHaveBeenCalledWith(expect.objectContaining({
      manualReplay: true
    }));
  });
});
