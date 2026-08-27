import { describe, expect, it, vi } from "vitest";

import {
  ContextGenerateError
} from "../../src/application/context/context-generator.js";
import {
  ContextLoadError
} from "../../src/application/context/context-loader.js";
import {
  ContextRehashError
} from "../../src/application/context/context-rehasher.js";
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
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { validReport } from "../fixtures/report.js";
import {
  contextSelection,
  projectContextIndex,
  projectContextModule,
  resolvedProjectContext
} from "../fixtures/project-context.js";
import type { Journey } from "../../src/domain/journey.js";
import { hashJourney } from "../../src/domain/report.js";
import { CONFIG_PATH } from "../../src/domain/workspace.js";

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
            pruned: 0,
            inventoryChanged: false
          }],
          blocked: []
        }))
      },
      contextGenerator: {
        generate: vi.fn(() => Promise.reject(new Error("unused")))
      },
      contextRehasher: {
        rehash: vi.fn(() => Promise.reject(new Error("unused")))
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
      align: {
        alignCamera: vi.fn(() => Promise.reject(new Error("unused")))
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
          publication: { status: "notRun" as const },
          externalFlows: []
        }))
      },
      workspaceLayout: fakeWorkspaceLayout(),
      runtimeObserver: {
        observe: vi.fn(() => Promise.resolve({
          binding: {
            generationId: "generation-1",
            baseRevision: 1,
            snapshotHash: "b".repeat(64)
          },
          snapshotHash: "b".repeat(64),
          snapshotRef: ".taphound/build/generations/generation-1/evidence/snapshots/revision-000001/attempt-1/snapshot.json",
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
    const commands = [
      program,
      ...program.commands,
      ...program.commands.flatMap((command) => command.commands)
    ];
    const configOptions = commands.flatMap(
      (command) => command.options.filter(
        (option) => option.long === "--config"
      )
    );

    expect(configOptions).toHaveLength(18);
    expect(configOptions.every(
      (option) => option.defaultValue === CONFIG_PATH
    )).toBe(true);
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
      "--config", "/project/.taphound/config.json",
      "--name", "Recorded",
      "--output", "/project/.taphound/journeys/recorded.json"
    ]);

    expect(test.value.recorder.record).toHaveBeenCalledWith({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Recorded",
      outputPath: "/project/.taphound/journeys/recorded.json"
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
      "--config", "/project/.taphound/config.json",
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
      "/project/.taphound/config.json"
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
      "--config", ".taphound/config.json",
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

  it("binds external flows to the session when --external-flow is given", async () => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? generationContext : runtimeConfig
    ));
    test.value.externalFlowResolver = {
      resolve: vi.fn(() => Promise.resolve({
        flow: {
          version: 1 as const,
          kind: "externalFlow" as const,
          name: "camera/photo-capture",
          description: "Camera photo capture",
          escapedPackageName: "com.android.camera",
          includes: [],
          steps: [{
            action: "click" as const,
            locator: { resourceId: "shutter_button" },
            expectedActivity: "com.android.camera.CameraActivity"
          }]
        },
        flowSha256: "a".repeat(64),
        stepCount: 1
      })),
      list: vi.fn()
    };
    vi.mocked(test.value.generationStarter.start).mockResolvedValueOnce({
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
      publication: { status: "notRun" as const },
      externalFlows: [{
        name: "camera/photo-capture",
        flowSha256: "a".repeat(64),
        escapedPackageName: "com.android.camera",
        stepCount: 1
      }]
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--config", ".taphound/config.json",
      "--context", "context.json",
      "--module", ":feature:search",
      "--device", "emulator-5554",
      "--external-flow", "camera/photo-capture",
      "--json"
    ]);

    const startInput = vi.mocked(
      test.value.generationStarter.start
    ).mock.calls[0]?.[0];
    expect(startInput).toMatchObject({
      externalFlows: [{
        name: "camera/photo-capture",
        flowSha256: "a".repeat(64),
        escapedPackageName: "com.android.camera",
        stepCount: 1
      }]
    });
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "started",
      exitCode: 0,
      externalFlows: [{
        name: "camera/photo-capture",
        flowSha256: "a".repeat(64),
        escapedPackageName: "com.android.camera",
        stepCount: 1
      }]
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("fails with FLOW_INVALID when an external flow cannot be resolved", async () => {
    const test = dependencies();
    vi.mocked(test.value.readJson).mockImplementation((path) => Promise.resolve(
      path.includes("context") ? generationContext : runtimeConfig
    ));
    test.value.externalFlowResolver = {
      resolve: vi.fn(() => Promise.reject(new Error("Flow not found"))),
      list: vi.fn()
    };

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--config", ".taphound/config.json",
      "--context", "context.json",
      "--module", ":feature:search",
      "--device", "emulator-5554",
      "--external-flow", "camera/missing",
      "--json"
    ]);

    expect(test.value.generationStarter.start).not.toHaveBeenCalled();
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "FLOW_INVALID" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("replays and binds a base Flow before generation starts", async () => {
    const test = dependencies();
    const journey = runtimeJourney;
    const manifest = {
      version: 1 as const,
      source: {
        path: ".taphound/flows/core/home.json",
        sha256: "1".repeat(64)
      },
      flows: [{
        name: "core/home",
        path: ".taphound/flows/core/home.json",
        sha256: "1".repeat(64),
        stepCount: 1
      }],
      expansion: ["core/home"],
      journey: {
        name: journey.name,
        sha256: hashJourney(journey),
        stepCount: 1
      },
      resolutionSha256: "2".repeat(64)
    };
    test.value.journeyResolver = {
      resolve: vi.fn(),
      resolveFlow: vi.fn(() => Promise.resolve({ journey, manifest })),
      listFlows: vi.fn()
    };
    const report = validReport({
      journey: {
        name: journey.name,
        sha256: hashJourney(journey)
      }
    });
    vi.mocked(test.value.verifier.verify).mockResolvedValueOnce({
      status: "passed",
      exitCode: 0,
      report,
      reportPath: "/reports/base/report.json",
      summaryPath: "/reports/base/summary.txt"
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--base-flow", "core/home",
      "--json"
    ]);

    expect(test.value.verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        config: runtimeConfig,
        journey,
        deviceSerial: "emulator-5554",
        requireFocusedInput: true,
        generatedReplayPolicy: true
      })
    );
    expect(test.value.generationStarter.start).toHaveBeenCalledWith(
      expect.objectContaining({
        baseFlow: {
          name: "core/home",
          resolutionSha256: "2".repeat(64),
          journey,
          verificationReport: report,
          verificationReportPath: "/reports/base/report.json"
        }
      })
    );
    expect(test.stderr.value).toContain(
      "TapHound: replaying base Flow core/home"
    );
    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "started",
      exitCode: 0
    });
  });

  it("fails closed when a selected base Flow does not replay", async () => {
    const test = dependencies();
    const journey: Journey = {
      version: 1,
      name: "Home to search",
      steps: [{
        action: "click",
        locator: { resourceId: "search" },
        activity: {
          before: "com.example.app.HomeActivity",
          after: "com.example.app.SearchActivity"
        },
        expect: {
          type: "element",
          locator: { resourceId: "search_results" },
          timeoutMs: 3_000
        }
      }]
    };
    test.value.journeyResolver = {
      resolve: vi.fn(),
      resolveFlow: vi.fn(() => Promise.resolve({
        journey,
        manifest: {
          version: 1 as const,
          source: {
            path: ".taphound/flows/core/home.json",
            sha256: "1".repeat(64)
          },
          flows: [{
            name: "core/home",
            path: ".taphound/flows/core/home.json",
            sha256: "1".repeat(64),
            stepCount: 1
          }],
          expansion: ["core/home"],
          journey: {
            name: journey.name,
            sha256: hashJourney(journey),
            stepCount: 1
          },
          resolutionSha256: "2".repeat(64)
        }
      })),
      listFlows: vi.fn()
    };
    vi.mocked(test.value.verifier.verify).mockResolvedValueOnce({
      status: "failed",
      exitCode: 1,
      report: validReport({
        status: "failed",
        primaryFailure: {
          code: "LOCATOR_NOT_FOUND",
          message: "shared navigation changed",
          phase: "locator",
          stepIndex: 0
        }
      }),
      reportPath: "/reports/base/report.json",
      summaryPath: "/reports/base/summary.txt"
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "start",
      "--project", "/project",
      "--context", "context.json",
      "--base-flow", "core/home",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "error",
      exitCode: 1,
      failure: {
        code: "FLOW_REPLAY_FAILED",
        message: "shared navigation changed",
        details: {
          flowName: "core/home",
          reportPath: "/reports/base/report.json",
          primaryFailure: {
            code: "LOCATOR_NOT_FOUND",
            phase: "locator",
            stepIndex: 0
          },
          failedStep: {
            stepIndex: 0,
            action: "click",
            activity: {
              before: "com.example.app.HomeActivity",
              after: "com.example.app.SearchActivity"
            },
            locator: { resourceId: "search" },
            expectation: {
              type: "element",
              locator: { resourceId: "search_results" },
              timeoutMs: 3_000
            }
          },
          recovery: [
            "Check that the first Flow step starts from a stable Activity deterministically reached after cold launch.",
            "Replace a transient Splash transition with a Home readiness anchor such as wait: Home -> Home plus an expectation for a unique Home element.",
            "Repair or re-record the Flow, then retry generation start.",
            "Omit --base-flow only when the user explicitly chooses to bypass reuse."
          ]
        }
      }
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.value.generationStarter.start).not.toHaveBeenCalled();
    expect(test.exitCodes).toEqual([1]);
  });

  it("resolves a composed Journey with one exact JSON result", async () => {
    const test = dependencies();
    const journey = runtimeJourney;
    const manifest = {
      version: 1 as const,
      source: {
        path: ".taphound/sources/search.json",
        sha256: "1".repeat(64)
      },
      flows: [{
        name: "core/home",
        path: ".taphound/flows/core/home.json",
        sha256: "2".repeat(64),
        stepCount: 1
      }],
      expansion: ["core/home"],
      journey: {
        name: journey.name,
        sha256: hashJourney(journey),
        stepCount: journey.steps.length
      },
      resolutionSha256: "3".repeat(64)
    };
    const writes: Array<{ relativePath: string; content: string }> = [];
    test.value.journeyResolver = {
      resolve: vi.fn(() => Promise.resolve({ journey, manifest })),
      resolveFlow: vi.fn(),
      listFlows: vi.fn()
    };
    test.value.journeyCompositionStore = {
      writeText: vi.fn((input: {
        relativePath: string;
        content: string;
      }) => {
        writes.push({
          relativePath: input.relativePath,
          content: input.content
        });
        return Promise.resolve();
      })
    };

    await createProgram(test.value).parseAsync([
      "node", "taphound", "journey", "resolve",
      "--project", "/project",
      "--source", ".taphound/sources/search.json",
      "--output", ".taphound/journeys/search.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toEqual({
      status: "resolved",
      exitCode: 0,
      journeyPath: ".taphound/journeys/search.json",
      manifestPath: ".taphound/journeys/search.resolve.json",
      journeySha256: hashJourney(journey),
      resolutionSha256: "3".repeat(64),
      stepCount: 1,
      flows: ["core/home"]
    });
    expect(writes.map((write) => write.relativePath)).toEqual([
      ".taphound/journeys/search.json",
      ".taphound/journeys/search.resolve.json"
    ]);
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.exitCodes).toEqual([0]);
  });

  it("lists reusable Flows with one exact JSON result", async () => {
    const test = dependencies();
    test.value.journeyResolver = {
      resolve: vi.fn(),
      resolveFlow: vi.fn(),
      listFlows: vi.fn(() => Promise.resolve([{
        name: "core/home",
        path: ".taphound/flows/core/home.json",
        status: "valid" as const,
        entryActivity: "com.example.app.MainActivity",
        exitActivity: "com.example.app.HomeActivity",
        stepCount: 1,
        resolutionSha256: "3".repeat(64)
      }]))
    };
    test.value.journeyCompositionStore = { writeText: vi.fn() };

    await createProgram(test.value).parseAsync([
      "node", "taphound", "journey", "list-flows",
      "--project", "/project",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "listed",
      exitCode: 0,
      flows: [{ name: "core/home", status: "valid" }]
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.exitCodes).toEqual([0]);
  });

  it("lists base and external Flows with --include-external", async () => {
    const test = dependencies();
    test.value.journeyResolver = {
      resolve: vi.fn(),
      resolveFlow: vi.fn(),
      listFlows: vi.fn(() => Promise.resolve([{
        name: "core/home",
        path: ".taphound/flows/core/home.json",
        status: "valid" as const,
        entryActivity: "com.example.app.MainActivity",
        exitActivity: "com.example.app.HomeActivity",
        stepCount: 1,
        resolutionSha256: "3".repeat(64)
      }]))
    };
    test.value.journeyCompositionStore = { writeText: vi.fn() };
    test.value.externalFlowResolver = {
      resolve: vi.fn(),
      list: vi.fn(() => Promise.resolve([{
        name: "camera/photo-capture",
        source: "builtin" as const,
        path: "assets/external-flows/camera/photo-capture.json",
        status: "valid" as const,
        escapedPackageName: "com.android.camera2",
        stepCount: 2
      }]))
    };

    await createProgram(test.value).parseAsync([
      "node", "taphound", "journey", "list-flows",
      "--project", "/project",
      "--include-external",
      "--json"
    ]);

    const parsed = JSON.parse(test.stdout.value) as {
      status: string;
      exitCode: number;
      flows: { name: string }[];
      externalFlows: { name: string; source: string }[];
    };
    expect(parsed.status).toBe("listed");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.flows[0]?.name).toBe("core/home");
    expect(parsed.externalFlows).toHaveLength(1);
    expect(parsed.externalFlows[0]?.name).toBe("camera/photo-capture");
    expect(parsed.externalFlows[0]?.source).toBe("builtin");
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
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
      snapshotRef: ".taphound/build/generations/generation-1/evidence/snapshots/revision-000001/attempt-1/snapshot.json",
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
        strategy: "hybrid",
        pollIntervalMs: 100,
        stablePolls: 1,
        timeoutMs: 500
      }
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("emits only binding and authoritative snapshotRef in compact observe mode", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "generation", "observe",
      "--project", "/project",
      "--session", "generation-1",
      "--compact",
      "--json"
    ]);

    const output = JSON.parse(test.stdout.value) as Record<string, unknown>;
    expect(output).toEqual({
      status: "observed",
      exitCode: 0,
      generationId: "generation-1",
      baseRevision: 1,
      snapshotHash: "b".repeat(64),
      snapshotRef: ".taphound/build/generations/generation-1/evidence/snapshots/revision-000001/attempt-1/snapshot.json"
    });
    expect(output).not.toHaveProperty("snapshot");
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
      appPreparer: { prepare: vi.fn(() => Promise.resolve()) },
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
        "--config", ".taphound/config.json",
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
      expect(test.value.contextValidator.validate).toHaveBeenCalledWith(
        command === "status"
          ? {
              context: generationContext,
              projectRoot: "/project",
              config: runtimeConfig,
              modules: [projectContextModule],
              reportScopes: true
            }
          : {
              context: generationContext,
              projectRoot: "/project",
              config: runtimeConfig
            }
      );
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
        resolution: "acceptSourceChanges" as const,
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
        new Error(".taphound/config.json unreadable")
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
      "--config", ".taphound/config.json",
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

  it("passes --prune-deleted through to the refresher", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "refresh",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--prune-deleted",
      "--accept-source-changes",
      "--json"
    ]);

    expect(test.value.contextRefresher.refresh).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json",
      pruneDeleted: true,
      acceptSourceChanges: true
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("includes validator scopes in context status --json output", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextValidator.validate).mockResolvedValueOnce({
      status: "stale",
      reason: {
        code: "EVIDENCE_HASH_MISMATCH",
        message: "Evidence file changed: app/src/main/source.kt"
      },
      scopes: [{
        id: ":app",
        inventoryChanged: false,
        missingPaths: [],
        changedPaths: ["app/src/main/source.kt"]
      }]
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "status",
      "--project", "/project",
      "--config", ".taphound/config.json",
      "--context", "project.context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "stale",
      scopes: [{
        id: ":app",
        changedPaths: ["app/src/main/source.kt"]
      }]
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("defaults --context to the conventional project Context path", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "status",
      "--project", "/project",
      "--config", ".taphound/config.json",
      "--json"
    ]);

    expect(test.value.contextLoader.load).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json",
      allowIncomplete: true
    });
  });

  it("generates Context scaffolding and emits exactly one JSON value", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextGenerator.generate).mockResolvedValueOnce({
      status: "generated",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      modules: [{
        id: ":app",
        projectDir: "app",
        kind: "application",
        status: "notAnalyzed",
        evidenceCount: 3,
        contextPath: ".taphound/context/modules/app.json",
        sha256: "a".repeat(64)
      }],
      indexHash: "b".repeat(64),
      contextPath: ".taphound/context/project-context.json"
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "generate",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "generated",
      exitCode: 0,
      packageName: "com.example.app",
      modules: [{ id: ":app", evidenceCount: 3 }]
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.value.contextGenerator.generate).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json"
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("passes --force through to the generator", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextGenerator.generate).mockResolvedValueOnce({
      status: "generated",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      modules: [],
      indexHash: "b".repeat(64),
      contextPath: ".taphound/context/project-context.json"
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "generate",
      "--project", "/project",
      "--force",
      "--json"
    ]);

    expect(test.value.contextGenerator.generate).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json",
      force: true
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("emits text output for context generate without --json", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextGenerator.generate).mockResolvedValueOnce({
      status: "generated",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      modules: [{
        id: ":app",
        projectDir: "app",
        kind: "application",
        status: "notAnalyzed",
        evidenceCount: 2,
        contextPath: ".taphound/context/modules/app.json",
        sha256: "a".repeat(64)
      }],
      indexHash: "b".repeat(64),
      contextPath: ".taphound/context/project-context.json"
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "generate",
      "--project", "/project"
    ]);

    expect(test.stdout.value).toContain("Context: generated (1 modules)");
    expect(test.stdout.value).toContain("Package: com.example.app");
    expect(test.stdout.value).toContain(":app: application (2 evidence files)");
    expect(test.exitCodes).toEqual([0]);
  });

  it("maps Context generate failures to exit 2", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextGenerator.generate).mockRejectedValueOnce(
      new ContextGenerateError(
        "CONTEXT_ALREADY_EXISTS",
        "Project Context already exists (use --force to overwrite)"
      )
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "generate",
      "--project", "/project",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONTEXT_ALREADY_EXISTS" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("maps Context generate internal errors to exit 4", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextGenerator.generate).mockRejectedValueOnce(
      new Error("unexpected")
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "generate",
      "--project", "/project",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 4,
      failure: { code: "INTERNAL_ERROR" }
    });
    expect(test.exitCodes).toEqual([4]);
  });

  it("rehashes Context and emits exactly one JSON value", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextRehasher.rehash).mockResolvedValueOnce({
      status: "rehashed",
      modules: [{
        id: ":app",
        previousSha256: "a".repeat(64),
        currentSha256: "c".repeat(64),
        changed: true
      }],
      previousIndexHash: "b".repeat(64),
      indexHash: "d".repeat(64)
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "rehash",
      "--project", "/project",
      "--context", ".taphound/context/project-context.json",
      "--module", ":app",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "rehashed",
      exitCode: 0,
      indexHash: "d".repeat(64)
    });
    expect(test.stdout.value.trim().split("\n")).toHaveLength(1);
    expect(test.value.contextRehasher.rehash).toHaveBeenCalledWith({
      projectRoot: "/project",
      contextPath: "/project/.taphound/context/project-context.json",
      moduleIds: [":app"]
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("emits text output for context rehash without --json", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextRehasher.rehash).mockResolvedValueOnce({
      status: "unchanged",
      modules: [{
        id: ":app",
        previousSha256: "a".repeat(64),
        currentSha256: "a".repeat(64),
        changed: false
      }],
      previousIndexHash: "b".repeat(64),
      indexHash: "b".repeat(64)
    });

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "rehash",
      "--project", "/project"
    ]);

    expect(test.stdout.value).toContain("Context: unchanged");
    expect(test.exitCodes).toEqual([0]);
  });

  it("maps Context rehash failures to exit 2", async () => {
    const test = dependencies();
    vi.mocked(test.value.contextRehasher.rehash).mockRejectedValueOnce(
      new ContextRehashError(
        "CONTEXT_INVALID",
        "Context shard is not valid JSON"
      )
    );

    await createProgram(test.value).parseAsync([
      "node", "taphound", "context", "rehash",
      "--project", "/project",
      "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONTEXT_INVALID" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("registers a top-level --version option", () => {
    const program = createProgram(dependencies().value);
    const versionOption = program.options.find(
      (option) => option.long === "--version"
    );
    expect(versionOption).toBeDefined();
  });
});
