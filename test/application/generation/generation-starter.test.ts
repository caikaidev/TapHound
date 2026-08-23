import { describe, expect, it, vi } from "vitest";

import {
  flowReplayFailureDetails,
  GenerationOperationError,
  GenerationStarter
} from "../../../src/application/generation/generation-starter.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type {
  ResolvedProjectContext
} from "../../../src/domain/project-context.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import { hashJourney } from "../../../src/domain/report.js";
import { contextSelection } from "../../fixtures/project-context.js";
import { validReport } from "../../fixtures/report.js";
import { runtimeJourney } from "../../fakes/runtime-fixture.js";

const config: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
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
    allowedActions: ["click", "wait"],
    confirmationRequiredActions: ["click"],
    forbiddenActions: ["back"]
  },
  selection: contextSelection
};

const project = {
  projectRoot: "/project",
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity"
};

function starter(validationStatus: "valid" | "stale" | "invalid" = "valid"): {
  service: GenerationStarter;
  created: GenerationSession[];
  prepare: ReturnType<typeof vi.fn>;
} {
  const created: GenerationSession[] = [];
  const ids = ["generation-core-id", "journey-run-id"];
  const prepare = vi.fn(() => Promise.resolve());
  return {
    created,
    prepare,
    service: new GenerationStarter({
      contextValidator: {
        validate: vi.fn(() => Promise.resolve(
          validationStatus === "valid"
            ? { status: "valid" as const }
            : {
                status: validationStatus,
                reason: {
                  code: validationStatus === "stale"
                    ? "EVIDENCE_HASH_MISMATCH" as const
                    : "CONTEXT_SCHEMA_INVALID" as const,
                  message: "context rejected"
                }
              }
        ))
      },
      appPreparer: { prepare },
      store: {
        create: vi.fn((session: GenerationSession) => {
          created.push(session);
          return Promise.resolve();
        })
      },
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      generateId: () => ids.shift() ?? "unexpected-id",
      randomBytes: () => Uint8Array.from([0, 10, 255])
    })
  };
}

describe("GenerationStarter", () => {
  it("relates launch readiness failures to the first Flow step", () => {
    expect(flowReplayFailureDetails({
      flowName: "core/launch-home",
      reportPath: "/reports/base/report.json",
      journey: runtimeJourney,
      report: validReport({
        status: "failed",
        primaryFailure: {
          code: "APP_LAUNCH_FAILED",
          message: "stable Activity was not reached",
          phase: "readiness"
        }
      })
    })).toMatchObject({
      primaryFailure: {
        code: "APP_LAUNCH_FAILED",
        phase: "readiness",
        stepIndex: null
      },
      failedStep: {
        stepIndex: 0,
        action: runtimeJourney.steps[0]?.action,
        activity: runtimeJourney.steps[0]?.activity,
        locator: { resourceId: "search" }
      }
    });
  });

  it("creates distinct Core-owned generation and Journey bindings", async () => {
    const test = starter();

    const session = await test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554"
    });

    expect(session).toEqual(test.created[0]);
    expect(session).toMatchObject({
      version: 1,
      id: "generation-core-id",
      revision: 0,
      state: "active",
      variables: {
        runId: "journey-run-id",
        timestamp: "2026-07-22T12:00:00.000Z",
        randomHex: "000aff"
      },
      target: {
        packageName: "com.example.app",
        deviceSerial: "emulator-5554",
        resetStrategy: "processOnly",
        interactionPolicy: context.interactionPolicy
      },
      candidateSteps: [],
      inFlight: null,
      pendingConfirmation: null,
      verification: { status: "notRun" },
      publication: { status: "notRun" }
    });
    expect(session.id).not.toBe(session.variables.runId);
    expect(session.bindings.projectHash).toMatch(/^[a-f\d]{64}$/);
    expect(session.bindings.configHash).toMatch(/^[a-f\d]{64}$/);
    expect(session.bindings.contextHash).toMatch(/^[a-f\d]{64}$/);
    expect(session.bindings.snapshotHash).toBeNull();
    expect(test.prepare).toHaveBeenCalledOnce();
    expect(test.prepare).toHaveBeenCalledWith({
      config,
      deviceSerial: "emulator-5554"
    });
  });

  it("computes deterministic canonical input hashes", async () => {
    const first = starter();
    const second = starter();

    const left = await first.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554"
    });
    const right = await second.service.start({
      deviceSerial: "emulator-5554",
      project: {
        ...project
      },
      context: {
        ...context,
        interactionPolicy: { ...context.interactionPolicy }
      },
      config: { ...config },
      projectRoot: "/project"
    });

    expect(right.bindings).toEqual(left.bindings);
  });

  it("binds a clean replayed Flow as the candidate prefix", async () => {
    const test = starter();
    const validStep = validReport().steps[0];
    if (validStep === undefined) {
      throw new Error("Expected valid report step fixture");
    }
    const stepWithoutExpectation = { ...validStep };
    delete stepWithoutExpectation.expectation;
    const verificationReport = validReport({
      journey: {
        name: runtimeJourney.name,
        sha256: hashJourney(runtimeJourney)
      },
      steps: [stepWithoutExpectation]
    });

    const session = await test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554",
      baseFlow: {
        name: "core/home",
        resolutionSha256: "f".repeat(64),
        journey: runtimeJourney,
        verificationReport,
        verificationReportPath: "/reports/base/report.json"
      }
    });

    expect(session.baseFlow).toMatchObject({
      name: "core/home",
      resolutionSha256: "f".repeat(64),
      journeySha256: hashJourney(runtimeJourney),
      verificationRunId: verificationReport.runId,
      stepCount: 1
    });
    expect(session.candidateSteps).toEqual(runtimeJourney.steps);
    expect(session.candidateSources).toEqual(["flow"]);
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it("rejects a failed or mismatched base Flow replay", async () => {
    const test = starter();
    const validStep = validReport().steps[0];
    if (validStep === undefined) {
      throw new Error("Expected valid report step fixture");
    }
    const stepWithoutExpectation = { ...validStep };
    delete stepWithoutExpectation.expectation;

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554",
      baseFlow: {
        name: "core/home",
        resolutionSha256: "f".repeat(64),
        journey: runtimeJourney,
        verificationReportPath: "/reports/base/report.json",
        verificationReport: validReport({
          status: "failed",
          journey: {
            name: runtimeJourney.name,
            sha256: hashJourney(runtimeJourney)
          },
          steps: [stepWithoutExpectation]
        })
      }
    })).rejects.toMatchObject({
      code: "FLOW_REPLAY_FAILED",
      details: {
        flowName: "core/home",
        reportPath: "/reports/base/report.json"
      }
    });
    expect(test.created).toEqual([]);
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it("does not create a session when app preparation fails", async () => {
    const test = starter();
    test.prepare.mockRejectedValueOnce(new Error("launch failed"));

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554"
    })).rejects.toMatchObject({
      code: "APP_LAUNCH_FAILED",
      message: "launch failed"
    });
    expect(test.created).toEqual([]);
  });

  it.each([
    ["stale", "CONTEXT_STALE"],
    ["invalid", "CONTEXT_INVALID"]
  ] as const)("rejects %s Context before Store creation", async (
    validationStatus,
    code
  ) => {
    const test = starter(validationStatus);

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554"
    })).rejects.toEqual(expect.objectContaining<
      Partial<GenerationOperationError>
    >({ code }));
    expect(test.created).toEqual([]);
  });

  it("allows stale evidence only with explicit drift opt-in", async () => {
    const test = starter("stale");

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554",
      allowEvidenceDrift: true
    })).resolves.toMatchObject({ state: "active" });
    expect(test.created).toHaveLength(1);
    expect(test.created[0]?.bindings.contextHash).toMatch(/^[a-f\d]{64}$/);
  });

  it.each([
    [
      "project root",
      { projectRoot: "/other-project" },
      "Project description root does not match requested project root"
    ],
    [
      "project package",
      { packageName: "com.other.app" },
      "Project package does not match configured package"
    ]
  ])("rejects a conflicting %s as CONFIG_INVALID", async (
    _identity,
    projectOverride,
    message
  ) => {
    const test = starter();

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context,
      project: { ...project, ...projectOverride },
      deviceSerial: "emulator-5554"
    })).rejects.toEqual(expect.objectContaining({
      code: "CONFIG_INVALID",
      message
    }));
    expect(test.created).toEqual([]);
  });

  it.each([
    ["package", { packageName: "com.other.app" }],
    ["launch Activity", { launchActivity: "com.example.app.OtherActivity" }]
  ])("rejects a conflicting Context %s as CONTEXT_INVALID", async (
    _identity,
    contextOverride
  ) => {
    const test = starter();

    await expect(test.service.start({
      projectRoot: "/project",
      config,
      context: { ...context, ...contextOverride },
      project,
      deviceSerial: "emulator-5554"
    })).rejects.toEqual(expect.objectContaining<
      Partial<GenerationOperationError>
    >({
      code: "CONTEXT_INVALID",
      message: "Context package and launch identity do not match the project"
    }));
    expect(test.created).toEqual([]);
  });

  it("does not accept caller-controlled identifiers or variables", async () => {
    const test = starter();

    await test.service.start({
      projectRoot: "/project",
      config,
      context,
      project,
      deviceSerial: "emulator-5554",
      id: "caller-generation-id",
      variables: {
        runId: "caller-run-id",
        timestamp: "2020-01-01T00:00:00.000Z",
        randomHex: "bad"
      }
    } as never);

    expect(test.created[0]?.id).toBe("generation-core-id");
    expect(test.created[0]?.variables.runId).toBe("journey-run-id");
  });
});
