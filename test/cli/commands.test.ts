import { describe, expect, it, vi } from "vitest";

import {
  ContextLoadError
} from "../../src/application/context/context-loader.js";
import {
  ContextRefreshError
} from "../../src/application/context/context-refresher.js";
import {
  GenerationOperationError,
  GenerationStarter
} from "../../src/application/generation/generation-starter.js";
import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import {
  GenerationSessionStoreError
} from "../../src/ports/generation-session-store.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { validReport } from "../fixtures/report.js";
import {
  contextSelection,
  projectContextIndex,
  projectContextModule,
  resolvedProjectContext
} from "../fixtures/project-context.js";

const generationContext = resolvedProjectContext;

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

function dependencies(): {
  value: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
} {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    value: {
      doctor: {
        run: vi.fn(() => Promise.resolve({
          status: "passed" as const,
          deviceSerial: "emulator-5554",
          checks: [
            { name: "node" as const, status: "passed" as const, version: "24.3.0" },
            { name: "adb" as const, status: "passed" as const, version: "1.0.41" },
            { name: "android" as const, status: "passed" as const, version: "0.1.0" }
          ]
        }))
      },
      recorder: {
        record: vi.fn(() => Promise.resolve({
          status: "completed" as const,
          stepsRecorded: 1,
          journey: runtimeJourney
        }))
      },
      verifier: {
        verify: vi.fn(() => Promise.resolve({
          status: "passed" as const,
          exitCode: 0 as const,
          report: validReport(),
          reportPath: "/reports/run/report.json",
          summaryPath: "/reports/run/summary.txt"
        }))
      },
      projectDescriber: {
        describe: vi.fn(() => Promise.resolve({
          projectRoot: "/project",
          packageName: "com.example.app",
          launchActivity: "com.example.app.MainActivity"
        }))
      },
      contextValidator: {
        validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
      },
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
      contextRefresher: {
        refresh: vi.fn(() => Promise.resolve({
          status: "refreshed" as const,
          indexHash: "a".repeat(64),
          acceptedSourceChanges: false,
          scopes: [{
            scope: "module" as const,
            id: ":app",
            contextPath: ".taphound/context/modules/app.json",
            written: true,
            semanticBackfilled: 2,
            formattingRehashed: 1,
            semanticChanged: [],
            unresolved: [],
            inventoryChanged: false
          }],
          blocked: []
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
      generationStarter: {
        start: vi.fn(() => Promise.resolve({
          version: 1 as const,
          id: "generation-1",
          revision: 0,
          state: "active" as const,
          bindings: {
            projectHash: "d".repeat(64),
            configHash: "e".repeat(64),
            contextHash: "a".repeat(64),
            snapshotHash: null
          },
          target: {
            packageName: "com.example.app",
            deviceSerial: "emulator-5554",
            resetStrategy: "processOnly" as const,
            interactionPolicy: {
              allowedActions: ["click" as const],
              confirmationRequiredActions: [],
              forbiddenActions: ["back" as const]
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
          verification: { status: "notRun" as const },
          publication: { status: "notRun" as const }
        }))
      },
      runtimeObserver: {
        observe: vi.fn(() => Promise.resolve({
          binding: {
            generationId: "generation-1",
            baseRevision: 1,
            snapshotHash: "b".repeat(64)
          },
          snapshotHash: "b".repeat(64),
          snapshot: {
            version: 1 as const,
            generationId: "generation-1",
            baseRevision: 1,
            deviceSerial: "emulator-5554",
            expectedPackageName: "com.example.app",
            foregroundPackageName: "com.example.app",
            activity: "com.example.app.MainActivity",
            pid: null,
            capturedAt: "2026-07-22T12:01:00.000Z",
            screenshotPath:
              "evidence/snapshots/revision-000001/screen.png",
            layout: []
          }
        }))
      },
      readJson: vi.fn((path: string) => Promise.resolve(
        path.includes("journey")
          ? runtimeJourney
          : path.includes("context")
            ? generationContext
            : runtimeConfig
      )),
      cwd: () => "/project",
      stdout,
      stderr,
      setExitCode: (code): void => {
        exitCodes.push(code);
      }
    }
  };
}

describe("TapHound CLI commands", () => {
  it("uses TapHound config defaults", () => {
    const program = createProgram(dependencies().value);
    const recordCommand = program.commands.find(
      (command) => command.name() === "record"
    );
    const verifyCommand = program.commands.find(
      (command) => command.name() === "verify"
    );

    expect(recordCommand?.options.find(
      (option) => option.long === "--config"
    )?.defaultValue).toBe("taphound.config.json");
    expect(verifyCommand?.options.find(
      (option) => option.long === "--config"
    )?.defaultValue).toBe("taphound.config.json");
  });

  it("prints a machine-readable doctor result", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "doctor", "--project", "/project", "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({ status: "passed" });
    expect(test.stderr.value).toBe("");
    expect(test.exitCodes).toEqual([0]);
  });

  it("loads config and invokes the interactive Recorder after preflight", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "record",
      "--project", "/project",
      "--config", "/project/taphound.config.json",
      "--name", "Recorded",
      "--output", "/project/journeys/recorded.json"
    ]);

    expect(test.value.recorder.record).toHaveBeenCalledWith({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Recorded",
      outputPath: "/project/journeys/recorded.json"
    });
    expect(test.stdout.value).toContain("Recorded 1 step");
    expect(test.exitCodes).toEqual([0]);
  });

  it("applies verify Package, Activity, device, and report overrides", async () => {
    const test = dependencies();
    const signal = new AbortController().signal;
    Object.assign(test.value, { signal });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "verify",
      "--project", "/project",
      "--config", "/project/taphound.config.json",
      "--journey", "/project/search.journey.json",
      "--device", "pixel-1",
      "--package", "com.override.app",
      "--activity", ".StartActivity",
      "--reports", "/tmp/taphound-reports"
    ]);

    expect(test.value.doctor.run).toHaveBeenCalledWith({
      packageName: "com.override.app",
      requestedDevice: "pixel-1",
      signal
    });
    const verifyInput = vi.mocked(test.value.verifier.verify).mock.calls[0]?.[0];
    expect(verifyInput).toMatchObject({
      projectRoot: "/project",
      deviceSerial: "pixel-1",
      config: {
        ...runtimeConfig,
        run: {
          packageName: "com.override.app",
          activity: ".StartActivity"
        },
        artifactsDir: "/tmp/taphound-reports"
      },
      journey: runtimeJourney
    });
    expect(verifyInput?.signal).toBe(signal);
  });

  it("describes stable project facts as exactly one JSON value", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "project", "describe",
      "--project", "/project",
      "--config", "taphound.config.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "described",
      exitCode: 0,
      projectRoot: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.value.readJson).toHaveBeenCalledWith(
      "/project/taphound.config.json"
    );
    expect(test.value.projectDescriber.describe).toHaveBeenCalledWith({
      projectRoot: "/project",
      config: runtimeConfig
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("starts a generation with one exact JSON result", async () => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? generationContext : runtimeConfig
    ));

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--config", "taphound.config.json",
      "--context", "context.json",
      "--module", ":feature:search",
      "--device", "emulator-5554",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "started",
      exitCode: 0,
      generationId: "generation-1",
      revision: 0,
      bindings: {
        projectHash: "d".repeat(64),
        configHash: "e".repeat(64),
        contextHash: "a".repeat(64),
        snapshotHash: null
      },
      contextSelection,
      variables: {
        runId: "journey-run-1",
        timestamp: "2026-07-22T12:00:00.000Z",
        randomHex: "00ff"
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
      }
    });
    expect(test.stdout.value.endsWith("\n")).toBe(true);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    const startInput = vi.mocked(
      test.value.generationStarter.start
    ).mock.calls[0]?.[0];
    expect(startInput).toMatchObject({
      projectRoot: "/project",
      config: runtimeConfig,
      context: generationContext,
      project: {
        projectRoot: "/project",
        packageName: "com.example.app"
      },
      deviceSerial: "emulator-5554"
    });
    expect(test.value.contextLoader.load).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/context.json",
      moduleIds: [":feature:search"]
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("observes a generation with one exact JSON result", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "observe",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "observed",
      exitCode: 0,
      generationId: "generation-1",
      baseRevision: 1,
      snapshotHash: "b".repeat(64),
      snapshot: {
        version: 1,
        generationId: "generation-1",
        baseRevision: 1,
        deviceSerial: "emulator-5554",
        expectedPackageName: "com.example.app",
        foregroundPackageName: "com.example.app",
        activity: "com.example.app.MainActivity",
        pid: null,
        capturedAt: "2026-07-22T12:01:00.000Z",
        screenshotPath: "evidence/snapshots/revision-000001/screen.png",
        layout: []
      }
    });
    expect(test.stdout.value.endsWith("\n")).toBe(true);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.value.runtimeObserver.observe).toHaveBeenCalledWith({
      projectRoot: "/project",
      generationId: "generation-1",
      idle: {
        pollIntervalMs: 100,
        stablePolls: 1,
        timeoutMs: 500
      }
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("maps invalid generation Context input to CONTEXT_INVALID", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextLoader.load).mockRejectedValueOnce(
      new ContextLoadError("CONTEXT_INVALID", "invalid Context")
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONTEXT_INVALID" }
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.exitCodes).toEqual([2]);
  });

  it("maps unreadable generation Context JSON to CONTEXT_INVALID", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextLoader.load).mockRejectedValueOnce(
      new ContextLoadError("CONTEXT_INVALID", "invalid Context JSON")
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 2,
      failure: {
        code: "CONTEXT_INVALID",
        message: "invalid Context JSON"
      }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("maps generation project conflicts to CONFIG_INVALID", async () => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? generationContext : runtimeConfig
    ));
    vi.mocked(test.value.generationStarter.start).mockRejectedValueOnce(
      new GenerationOperationError("CONFIG_INVALID", "metadata package conflict")
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it.each([
    [
      "root",
      {
        projectRoot: "/other-project",
        packageName: "com.example.app"
      },
      "Project description root does not match requested project root"
    ],
    [
      "package",
      {
        projectRoot: "/project",
        packageName: "com.other.app"
      },
      "Project package does not match configured package"
    ]
  ])("maps a returned conflicting ProjectDescription %s to exact CONFIG_INVALID JSON", async (
    _identity,
    projectIdentity,
    message
  ) => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? generationContext : runtimeConfig
    ));
    vi.mocked(test.value.projectDescriber.describe).mockResolvedValueOnce({
      ...projectIdentity,
      launchActivity: "com.example.app.MainActivity"
    });
    test.value.generationStarter = new GenerationStarter({
      contextValidator: test.value.contextValidator,
      store: { create: vi.fn((): Promise<void> => Promise.resolve()) },
      now: (): Date => new Date("2026-07-22T12:00:00.000Z"),
      generateId: (): string => "unused-id",
      randomBytes: (): Uint8Array => new Uint8Array()
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 2,
      failure: {
        code: "CONFIG_INVALID",
        message
      }
    });
    expect(test.stdout.value.endsWith("\n")).toBe(true);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.exitCodes).toEqual([2]);
  });

  it.each([
    new GenerationSessionStoreError("REVISION_CONFLICT", "revision changed"),
    new GenerationOperationError("SNAPSHOT_STALE", "binding changed")
  ])("maps observe binding conflicts to SNAPSHOT_STALE", async (error) => {
    const test = dependencies();
    vi.mocked(test.value.runtimeObserver.observe).mockRejectedValueOnce(error);

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "observe",
      "--project", "/project",
      "--session", "generation-1",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 1,
      failure: {
        code: "SNAPSHOT_STALE",
        message: error.message
      }
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.exitCodes).toEqual([1]);
  });

  it("maps invalid project config and metadata conflicts to config errors", async () => {
    const invalidConfig = dependencies();
    vi.mocked(invalidConfig.value.readJson).mockRejectedValue(
      new Error("config unreadable")
    );

    await createProgram(invalidConfig.value).parseAsync([
      "node", "taphound", "project", "describe", "--json"
    ]);

    expect(JSON.parse(invalidConfig.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID", message: "config unreadable" }
    });
    expect(invalidConfig.stderr.value).toBe("");
    expect(invalidConfig.exitCodes).toEqual([2]);

    const conflict = dependencies();
    vi.mocked(conflict.value.projectDescriber.describe).mockRejectedValue(
      new Error("metadata package conflict")
    );

    await createProgram(conflict.value).parseAsync([
      "node", "taphound", "project", "describe", "--json"
    ]);

    expect(JSON.parse(conflict.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 4,
      failure: {
        code: "INTERNAL_ERROR",
        message: "metadata package conflict"
      }
    });
    expect(conflict.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(conflict.stderr.value).toBe("");
    expect(conflict.exitCodes).toEqual([4]);
  });

  it.each([
    ["validate", "valid", 0],
    ["validate", "stale", 1],
    ["validate", "invalid", 2],
    ["status", "valid", 0],
    ["status", "stale", 0],
    ["status", "invalid", 2]
  ] as const)(
    "maps context %s status %s to exit %i with full validator output",
    async (command, status, exitCode) => {
      const test = dependencies();
      const validation = status === "valid"
        ? { status }
        : {
            status,
            reason: {
              code: status === "stale"
                ? "EVIDENCE_HASH_MISMATCH" as const
                : "CONTEXT_SCHEMA_INVALID" as const,
              message: `${status} context`
            }
          };
      vi.mocked(test.value.contextValidator.validate)
        .mockResolvedValue(validation);

      await createProgram(test.value).parseAsync([
        "node", "taphound", "context", command,
        "--project", "/project",
        "--config", "taphound.config.json",
        "--context", "project.context.json",
        "--json"
      ]);

      expect(JSON.parse(test.stdout.value)).toEqual({
        ...validation,
        contextSelection,
        modules: [{ id: ":app", status: "complete" }],
        exitCode
      });
      expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
      expect(test.stderr.value).toBe("");
      expect(test.value.contextValidator.validate).toHaveBeenCalledWith({
        context: generationContext,
        projectRoot: "/project",
        config: runtimeConfig
      });
      expect(test.exitCodes).toEqual([exitCode]);
    }
  );

  it("lists the compact v2 Context module index", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "list",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "listed",
      exitCode: 0,
      version: 2,
      indexHash: contextSelection.indexHash,
      modules: projectContextIndex.modules
    });
    expect(test.value.contextLoader.readIndex).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json"
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("refreshes Context evidence hashes with selected modules", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "refresh",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--module", ":app",
      "--accept-source-changes",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "refreshed",
      exitCode: 0,
      indexHash: "a".repeat(64)
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.value.contextRefresher.refresh).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json",
      moduleIds: [":app"],
      acceptSourceChanges: true
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("maps blocked Context refresh to exit 1", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextRefresher.refresh).mockResolvedValueOnce({
      status: "blocked",
      indexHash: "b".repeat(64),
      acceptedSourceChanges: false,
      scopes: [],
      blocked: [{
        code: "EVIDENCE_SEMANTIC_CHANGED",
        message: ":app: 1 evidence files changed semantically (a.kt)"
      }]
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "refresh",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "blocked",
      exitCode: 1
    });
    expect(test.exitCodes).toEqual([1]);
  });

  it("maps Context refresh failures to exit 2", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextRefresher.refresh).mockRejectedValueOnce(
      new ContextRefreshError(
        "CONTEXT_MODULE_NOT_FOUND",
        "Project Context module does not exist: :missing"
      )
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "refresh",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--module", ":missing",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONTEXT_MODULE_NOT_FOUND" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it.each([
    ["config read", "CONFIG_INVALID"],
    ["context read", "CONTEXT_INVALID"]
  ])("isolates context %s failures to one JSON stdout value", async (
    failureCase,
    expectedCode
  ) => {
    const test = dependencies();
    if (failureCase === "config read") {
      vi.mocked(test.value.readJson).mockRejectedValueOnce(
        new Error("taphound.config.json unreadable")
      );
    } else {
      vi.mocked(test.value.contextLoader.load).mockRejectedValueOnce(
        new ContextLoadError(
          "CONTEXT_INVALID",
          "project.context.json unreadable"
        )
      );
    }

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "validate",
      "--project", "/project",
      "--config", "taphound.config.json",
      "--context", "project.context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject(
      failureCase === "context read"
        ? {
            status: "invalid",
            exitCode: 2,
            reason: { code: "CONTEXT_SCHEMA_INVALID" }
          }
        : {
            status: "error",
            exitCode: 2,
            failure: { code: expectedCode }
          }
    );
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.value.contextValidator.validate).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([2]);
  });
});
