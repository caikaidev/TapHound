import { describe, expect, it, vi } from "vitest";

import {
  GenerationOperationError
} from "../../src/application/generation/generation-starter.js";
import { ProjectConfigurationError } from "../../src/application/project/project-describer.js";
import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import {
  GenerationSessionStoreError
} from "../../src/ports/generation-session-store.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { validReport } from "../fixtures/report.js";

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
    allowedActions: ["click" as const],
    confirmationRequiredActions: [],
    forbiddenActions: ["back" as const]
  }
};

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
          buildTask: ":app:assembleDebug",
          artifactTarget: "app",
          variant: "debug",
          launchActivity: "com.example.app.MainActivity",
          apkPath: "/project/app-debug.apk",
          metadataPaths: ["/project/output-metadata.json"],
          metadataPackageName: "com.example.app"
        }))
      },
      contextValidator: {
        validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
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
          variables: {
            runId: "journey-run-1",
            timestamp: "2026-07-22T12:00:00.000Z",
            randomHex: "00ff"
          },
          candidateSteps: [],
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
            ? { version: 1, opaque: "passed to validator" }
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

    expect(test.value.doctor.run).toHaveBeenCalledWith(
      "/project",
      signal,
      "pixel-1"
    );
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
      buildTask: ":app:assembleDebug",
      artifactTarget: "app",
      variant: "debug",
      launchActivity: "com.example.app.MainActivity",
      apkPath: "/project/app-debug.apk",
      metadataPaths: ["/project/output-metadata.json"],
      metadataPackageName: "com.example.app"
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
      generationId: "generation-1"
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("maps invalid generation Context input to CONTEXT_INVALID", async () => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? { version: 1, invalid: true } : runtimeConfig
    ));

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
    vi.mocked(test.value.readJson).mockImplementation((path) => (
      path.includes("context")
        ? Promise.reject(new Error("invalid Context JSON"))
        : Promise.resolve(runtimeConfig)
    ));

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
    vi.mocked(test.value.projectDescriber.describe).mockRejectedValueOnce(
      new ProjectConfigurationError("metadata package conflict")
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
      new ProjectConfigurationError("metadata package conflict")
    );

    await createProgram(conflict.value).parseAsync([
      "node", "taphound", "project", "describe", "--json"
    ]);

    expect(JSON.parse(conflict.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: {
        code: "CONFIG_INVALID",
        message: "metadata package conflict"
      }
    });
    expect(conflict.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(conflict.stderr.value).toBe("");
    expect(conflict.exitCodes).toEqual([2]);
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
        exitCode
      });
      expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
      expect(test.stderr.value).toBe("");
      expect(test.value.contextValidator.validate).toHaveBeenCalledWith({
        context: { version: 1, opaque: "passed to validator" },
        projectRoot: "/project",
        config: runtimeConfig
      });
      expect(test.exitCodes).toEqual([exitCode]);
    }
  );

  it.each([
    ["config read", "taphound.config.json"],
    ["context read", "project.context.json"]
  ])("isolates context %s failures to one JSON stdout value", async (
    _case,
    failingPath
  ) => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path: string) => (
      path.endsWith(failingPath)
        ? Promise.reject(new Error(`${failingPath} unreadable`))
        : Promise.resolve(runtimeConfig)
    ));

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "validate",
      "--project", "/project",
      "--config", "taphound.config.json",
      "--context", "project.context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.stderr.value).toBe("");
    expect(test.value.contextValidator.validate).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([2]);
  });
});
