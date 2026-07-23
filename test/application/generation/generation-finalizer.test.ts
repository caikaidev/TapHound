import { readFile, rm, mkdtemp } from "node:fs/promises";
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
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  FileSystemJourneyWriter
} from "../../../src/adapters/filesystem/journey-writer.js";
import {
  GenerationFinalizer
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
import type {
  ProjectContext
} from "../../../src/domain/project-context.js";
import {
  hashJourney,
  type TapHoundReport
} from "../../../src/domain/report.js";
import type {
  GenerationMetaWriterPort
} from "../../../src/ports/generation-meta-writer.js";
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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

const config: TapHoundConfig = {
  version: 1,
  build: { task: ":app:assembleDebug" },
  artifact: { target: "app", variant: "debug" },
  run: { packageName: "com.example.app", activity: ".MainActivity" },
  idle: { pollIntervalMs: 100, stablePolls: 2, timeoutMs: 5_000 },
  artifactsDir: ".taphound/reports"
};

const context: ProjectContext = {
  version: 1,
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
  }
};

function project(root: string): {
  projectRoot: string;
  packageName: string;
  buildTask: string;
  artifactTarget: string;
  variant: string;
  launchActivity: string;
  apkPath: string;
  metadataPaths: string[];
  metadataPackageName: string;
} {
  return {
    projectRoot: root,
    packageName: "com.example.app",
    buildTask: ":app:assembleDebug",
    artifactTarget: "app",
    variant: "debug",
    launchActivity: "com.example.app.MainActivity",
    apkPath: join(root, "app-debug.apk"),
    metadataPaths: [join(root, "output-metadata.json")],
    metadataPackageName: "com.example.app"
  };
}

function report(fallbackUsed = false): TapHoundReport {
  const journey = {
    version: 1 as const,
    name: "generated",
    steps: [{
      action: "wait" as const,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      }
    }]
  };
  return {
    schemaVersion: 1,
    runId: "verify-run",
    status: "passed",
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    durationMs: 1_000,
    project: {
      root: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "generated", sha256: hashJourney(journey) },
    environment: {
      deviceSerial: "emulator-5554",
      tools: { adb: "1" }
    },
    layers: {
      build: "passed",
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
      durationMs: 1
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
      }
    }],
    candidateSources: ["manualOverride"],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

type VerifyFunction = (input: VerifyInput) => Promise<VerifyResult>;
type ForceStopFunction = (identity: AppIdentity) => Promise<CommandResult>;

interface FinalizerFixture {
  root: string;
  store: FileSystemGenerationSessionStore;
  finalize: GenerationFinalizer;
  verify: Mock<VerifyFunction>;
  forceStop: Mock<ForceStopFunction>;
}

async function fixture(metaWriter: GenerationMetaWriterPort = (
  new FileSystemGenerationMetaWriter()
)): Promise<FinalizerFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-finalizer-"));
  roots.push(root);
  const store = new FileSystemGenerationSessionStore(root);
  await store.create(session(root));
  const verify = vi.fn<VerifyFunction>(() => Promise.resolve({
    status: "passed" as const,
    exitCode: 0 as const,
    report: report(),
    reportPath: "/reports/report.json",
    summaryPath: "/reports/summary.txt"
  }));
  const forceStop = vi.fn<ForceStopFunction>(
    () => Promise.resolve(commandResult())
  );
  const publisher = new GenerationPublisher({
    store,
    journeyWriter: new FileSystemJourneyWriter(),
    metaWriter
  });
  return {
    root,
    store,
    verify,
    forceStop,
    finalize: new GenerationFinalizer({
      store,
      contextValidator: {
        validate: vi.fn(
          () => Promise.resolve({ status: "valid" as const })
        )
      },
      adb: { forceStop },
      verifyRuntime: { verify },
      publisher,
      generateAttemptId: (): string => "verification-attempt"
    })
  };
}

function input(root: string): {
  generationId: string;
  projectRoot: string;
  config: TapHoundConfig;
  context: ProjectContext;
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
    outputPath: "journeys/generated.json",
    deviceSerial: "emulator-5554",
    toolVersions: { adb: "1" }
  };
}

describe("GenerationFinalizer", () => {
  it("replays exactly once and publishes a verified immutable bundle", async () => {
    const test = await fixture();

    const result = await test.finalize.finalize(input(test.root));

    expect(result.status).toBe("verified");
    expect(result.replayed).toBe(true);
    expect(result.journey.name).toBe("generated");
    expect(result.meta.manualOverrideStepIndexes).toEqual([0]);
    expect(test.forceStop).toHaveBeenCalledOnce();
    expect(test.verify).toHaveBeenCalledOnce();
    expect(test.verify).toHaveBeenCalledWith(expect.objectContaining({
      requireFocusedInput: true
    }));
    const manifest = JSON.parse(await readFile(join(
      test.root,
      ".taphound/generations/generation-1/manifest.json"
    ), "utf8")) as { files: { path: string }[] };
    expect(manifest.files.map((file) => file.path)).toEqual([
      "candidate/journey.json",
      "verified/journey.json",
      "generation-report.json",
      "verification/report.json",
      "verification/receipt.json",
      "meta.json"
    ]);
    await expect(readFile(
      join(test.root, "journeys/generated.json"),
      "utf8"
    )).resolves.toContain('"version": 1');
    await expect(readFile(
      join(test.root, "journeys/generated.meta.json"),
      "utf8"
    )).resolves.toContain('"status": "verified"');
  });

  it("retries a failed meta export without replaying verification", async () => {
    const failingMeta: GenerationMetaWriterPort = {
      write: vi.fn((): Promise<void> => Promise.reject(new Error("disk full")))
    };
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
      adb: { forceStop: test.forceStop },
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
    expect(test.forceStop).toHaveBeenCalledOnce();
  });

  it("rejects fallback verification and durably prevents replay", async () => {
    const test = await fixture();
    test.verify.mockResolvedValue({
      status: "passed",
      exitCode: 0,
      report: report(true),
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
          report: report(),
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

  it("rejects changed project bindings before process reset", async () => {
    const test = await fixture();
    const changed = input(test.root);
    changed.project = {
      ...changed.project,
      variant: "release"
    };

    await expect(test.finalize.finalize(changed)).rejects.toMatchObject({
      code: "CONTEXT_STALE",
      stage: "precondition"
    });
    expect(test.forceStop).not.toHaveBeenCalled();
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("rejects output paths that overlap the authoritative generation bundle", async () => {
    const test = await fixture();
    const invalid = input(test.root);
    invalid.outputPath = ".taphound/generations/generation-1/journey.json";

    await expect(test.finalize.finalize(invalid)).rejects.toThrow(
      /authoritative bundle/i
    );
    expect(test.forceStop).not.toHaveBeenCalled();
    expect(test.verify).not.toHaveBeenCalled();
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
});
