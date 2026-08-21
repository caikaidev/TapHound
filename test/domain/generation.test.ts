import { describe, expect, it } from "vitest";

import {
  GENERATION_ERROR_CODES,
  GenerationBundleManifestSchema,
  GenerationMetaSchema,
  GenerationReportSchema,
  GenerationSessionSchema,
  bindGenerationVariables,
  expandProposedStepVariables,
  generationCoreIdentity,
  hashGenerationConfirmationEvidence
} from "../../src/domain/generation.js";

const hashes = {
  projectHash: "d".repeat(64),
  configHash: "e".repeat(64),
  contextHash: "a".repeat(64),
  snapshotHash: null
};

const variables = {
  runId: "run-42",
  timestamp: "2026-07-22T12:00:00.000Z",
  randomHex: "c0ffee"
};

const contextSelection = {
  bundleVersion: 2,
  indexHash: "f".repeat(64),
  modules: [{
    id: ":app",
    sha256: "e".repeat(64),
    projectDir: "app",
    inventory: {
      pathSetSha256: "c".repeat(64),
      categories: ["manifests", "sources", "layouts", "navigation"]
    }
  }]
};

const proposalBinding = {
  generationId: "generation-1",
  baseRevision: 1,
  snapshotHash: "b".repeat(64)
};

const passedVerification = {
  status: "passed" as const,
  attemptId: "verification-attempt",
  reportPath: "verification/report.json",
  reportSha256: "f".repeat(64),
  runId: "verification-run"
};

describe("generation confirmation evidence", () => {
  it("authenticates canonical evidence including provenance", () => {
    const envelope = {
      version: 1 as const,
      proposal: {
        action: "wait" as const,
        binding: proposalBinding,
        activity: { before: "com.example.app.MainActivity" }
      },
      snapshot: {
        version: 1 as const,
        generationId: "generation-1",
        baseRevision: 1,
        deviceSerial: "emulator-5554",
        expectedPackageName: "com.example.app",
        foregroundPackageName: "com.example.app",
        activity: "com.example.app.MainActivity",
        pid: 42,
        capturedAt: "2026-07-22T12:00:00.000Z",
        layout: []
      },
      source: "planner" as const
    };

    expect(hashGenerationConfirmationEvidence(envelope)).toMatch(
      /^[a-f\d]{64}$/
    );
    expect(hashGenerationConfirmationEvidence({
      ...envelope,
      source: "manualOverride"
    })).not.toBe(hashGenerationConfirmationEvidence(envelope));
    expect(hashGenerationConfirmationEvidence({
      source: envelope.source,
      snapshot: envelope.snapshot,
      proposal: envelope.proposal,
      version: envelope.version
    })).toBe(hashGenerationConfirmationEvidence(envelope));
  });
});

function validSession(): unknown {
  return {
    version: 1,
    id: "generation-1",
    revision: 0,
    state: "active",
    bindings: hashes,
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
    variables,
    candidateSteps: [{
      action: "wait",
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      }
    }],
    candidateSources: ["planner"],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

describe("generation error contract", () => {
  it("defines generation-only error codes", () => {
    expect(GENERATION_ERROR_CODES).toEqual([
      "CONFIG_INVALID",
      "CONTEXT_INVALID",
      "CONTEXT_STALE",
      "FLOW_INVALID",
      "FLOW_REPLAY_FAILED",
      "SNAPSHOT_STALE",
      "PACKAGE_ESCAPE",
      "APP_CRASHED",
      "IDLE_TIMEOUT",
      "WINDOW_HIERARCHY_INCOMPLETE",
      "ACTION_UNSUPPORTED",
      "RISK_CONFIRMATION_REQUIRED",
      "ACTION_FORBIDDEN",
      "EXPECT_UNSUPPORTED",
      "RECOVERY_REQUIRED",
      "VERIFICATION_FAILED",
      "PUBLICATION_FAILED",
      "EXPORT_FAILED",
      "FINALIZATION_IN_PROGRESS"
    ]);
  });
});

describe("generation finalization evidence schemas", () => {
  it("parses aligned strict verified meta and provenance", () => {
    expect(GenerationMetaSchema.parse({
      version: 1,
      status: "verified",
      generationId: "generation-1",
      journeyPath: ".taphound/journeys/generated.json",
      bindings: {
        projectHash: "a".repeat(64),
        configHash: "b".repeat(64),
        contextHash: "c".repeat(64)
      },
      verification: {
        reportPath: "verification/report.json",
        reportSha256: "d".repeat(64),
        runId: "verify-run",
        runs: 1
      },
      baseFlow: {
        name: "core/home",
        resolutionSha256: "e".repeat(64),
        journeySha256: "f".repeat(64),
        verificationReportSha256: "1".repeat(64),
        verificationRunId: "base-run",
        stepCount: 1
      },
      manualOverrideStepIndexes: [1]
    })).toMatchObject({ status: "verified" });
    expect(GenerationReportSchema.parse({
      version: 1,
      generationId: "generation-1",
      status: "verified",
      steps: [
        { index: 0, source: "flow" },
        { index: 1, source: "manualOverride" }
      ]
    }).steps).toHaveLength(2);
  });

  it("rejects duplicate, escaped, and self-referential manifest paths", () => {
    const entry = {
      path: "verified/journey.json",
      bytes: 1,
      sha256: "a".repeat(64)
    };
    for (const files of [
      [entry, entry],
      [{ ...entry, path: "../journey.json" }],
      [{ ...entry, path: "manifest.json" }]
    ]) {
      expect(() => GenerationBundleManifestSchema.parse({
        version: 1,
        generationId: "generation-1",
        files
      })).toThrow();
    }
  });
});

describe("GenerationSessionSchema", () => {
  it("requires a safe Core-generated attempt id for inFlight execution", () => {
    const input = {
      ...(validSession() as object),
      inFlight: {
        stepIndex: 1,
        snapshotHash: "b".repeat(64),
        proposalHash: "c".repeat(64),
        attemptId: "attempt-1"
      }
    };

    expect(GenerationSessionSchema.parse(input)).toMatchObject({
      inFlight: { attemptId: "attempt-1" }
    });
    expect(() => GenerationSessionSchema.parse({
      ...input,
      inFlight: {
        ...input.inFlight,
        attemptId: "../escape"
      }
    })).toThrow(/attempt/i);
  });

  it("parses the initial strict session state", () => {
    expect(GenerationSessionSchema.parse(validSession())).toEqual(validSession());
  });

  it("accepts only nonnegative safe-integer session revisions", () => {
    expect(GenerationSessionSchema.parse({
      ...(validSession() as object),
      revision: Number.MAX_SAFE_INTEGER
    }).revision).toBe(Number.MAX_SAFE_INTEGER);
    for (const revision of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      expect(() => GenerationSessionSchema.parse({
        ...(validSession() as object),
        revision
      })).toThrow();
    }
  });

  it("rejects unknown fields", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      plannerConfidence: 0.99
    })).toThrow();
  });

  it("keeps generation identity separate from Journey runId bindings", () => {
    const parsed = GenerationSessionSchema.parse({
      ...(validSession() as object),
      id: "generation-identity",
      variables: {
        ...variables,
        runId: "journey-run-binding"
      }
    });

    expect(parsed.id).toBe("generation-identity");
    expect(parsed.variables.runId).toBe("journey-run-binding");
  });

  it("requires Core environment bindings and permits no initial snapshot", () => {
    const parsed = GenerationSessionSchema.parse(validSession());

    expect(parsed.bindings).toEqual(hashes);
    expect(parsed.target).toMatchObject({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly"
    });
  });

  it("binds Flow provenance only as a contiguous candidate prefix", () => {
    const flowStep = {
      action: "wait" as const,
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      }
    };
    const parsed = GenerationSessionSchema.parse({
      ...(validSession() as object),
      baseFlow: {
        name: "core/home",
        resolutionSha256: "1".repeat(64),
        journeySha256: "2".repeat(64),
        verificationReportSha256: "3".repeat(64),
        verificationRunId: "base-run",
        stepCount: 1
      },
      candidateSteps: [flowStep],
      candidateSources: ["flow"]
    });
    expect(parsed.baseFlow?.name).toBe("core/home");

    expect(() => GenerationSessionSchema.parse({
      ...parsed,
      candidateSources: ["planner"]
    })).toThrow(/provenance/i);
  });

  it("projects every immutable Core-owned identity field", () => {
    const session = GenerationSessionSchema.parse(validSession());

    expect(generationCoreIdentity(session)).toEqual({
      id: "generation-1",
      bindings: {
        projectHash: "d".repeat(64),
        configHash: "e".repeat(64),
        contextHash: "a".repeat(64)
      },
      target: session.target,
      contextSelection,
      variables: session.variables
    });
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "nested/id",
    String.raw`nested\id`,
    "/absolute",
    String.raw`C:\outside`,
    String.raw`\\server\share`
  ])("rejects invalid generation id %s", (id) => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      id
    })).toThrow(/generation session id/i);
  });

  it("rejects simultaneous execution and pending confirmation", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 1, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" },
      pendingConfirmation: {
        challengeId: "challenge-1",
        stepIndex: 1,
        proposalHash: "c".repeat(64),
        snapshotHash: "b".repeat(64),
        evidenceHash: "e".repeat(64),
        actionSummary: "Back from com.example.app.MainActivity",
        expiresAt: "2026-07-22T12:00:30.000Z",
        status: "pending"
      }
    })).toThrow(/inFlight.*pendingConfirmation/i);
  });

  it("requires recoveryRequired state to retain inFlight evidence", () => {
    expect(GenerationSessionSchema.parse({
      ...(validSession() as object),
      state: "recoveryRequired",
      inFlight: { stepIndex: 1, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    })).toMatchObject({
      state: "recoveryRequired",
      inFlight: { stepIndex: 1 }
    });
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      state: "recoveryRequired",
      inFlight: null
    })).toThrow(/recoveryRequired.*inFlight/i);
  });

  it("rejects publication before successful verification", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      publication: {
        status: "published",
        journeyPath: ".taphound/journeys/generated.json"
      }
    })).toThrow(/verification/i);
  });

  it.each([
    "/tmp/generated.json",
    String.raw`C:\outside.json`,
    String.raw`\\server\share\outside.json`,
    "../outside.json",
    String.raw`..\outside.json`,
    String.raw`journeys/..\outside.json`
  ])("rejects escaped publication journey path %s", (journeyPath) => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      verification: passedVerification,
      publication: { status: "published", journeyPath }
    })).toThrow(/within the project/i);
  });

  it("normalizes a safe publication journey path", () => {
    const parsed = GenerationSessionSchema.parse({
      ...(validSession() as object),
      verification: passedVerification,
      publication: {
        status: "published",
        journeyPath: String.raw`.taphound\journeys\generated.json`
      }
    });

    expect(parsed.publication).toEqual({
      status: "published",
      journeyPath: ".taphound/journeys/generated.json"
    });
  });

  it("rejects verification while a candidate step is active", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 1, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" },
      verification: {
        status: "running",
        attemptId: "verification-attempt"
      }
    })).toThrow(/verification/i);
  });

  it("requires active step state to identify the exact next candidate index", () => {
    expect(GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 1, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    })).toMatchObject({ inFlight: { stepIndex: 1 } });
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    })).toThrow(/next candidate/i);
  });

  it("stores only successful Journey steps, never proposal evidence", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      candidateSteps: [{
        binding: proposalBinding,
        action: "wait",
        activity: { before: "com.example.app.MainActivity" }
      }]
    })).toThrow();
  });
});

describe("generation variables", () => {
  it("binds only Core-owned variables", () => {
    expect(bindGenerationVariables(variables)).toEqual(variables);
    expect(() => bindGenerationVariables({
      ...variables,
      plannerValue: "untrusted"
    })).toThrow();
  });

  it.each([
    { ...variables, runId: "run id" },
    { ...variables, timestamp: "22 July 2026" },
    { ...variables, randomHex: "not-hex" }
  ])("rejects malformed Core variable bindings", (bindings) => {
    expect(() => bindGenerationVariables(bindings)).toThrow();
  });

  it.each([
    { ...variables, runId: "${timestamp}" },
    { ...variables, timestamp: "${runId}" },
    { ...variables, randomHex: "${runId}" }
  ])("rejects template markers in Core variable bindings", (bindings) => {
    expect(() => bindGenerationVariables(bindings)).toThrow(/literal/i);
  });

  it("expands bound variables into literal proposed-step strings", () => {
    expect(expandProposedStepVariables({
      binding: proposalBinding,
      action: "inputText",
      text: "run=${runId};time=${timestamp};nonce=${randomHex}",
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toEqual({
      binding: proposalBinding,
      action: "inputText",
      text: "run=run-42;time=2026-07-22T12:00:00.000Z;nonce=c0ffee",
      activity: { before: "com.example.app.MainActivity" }
    });
  });

  it("preserves unrelated JSON braces while expanding variables", () => {
    expect(expandProposedStepVariables({
      binding: proposalBinding,
      action: "inputText",
      text: "json={\"run\":\"${runId}\"}",
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toMatchObject({
      text: "json={\"run\":\"run-42\"}"
    });
  });

  it("rejects unbound variable references", () => {
    expect(() => expandProposedStepVariables({
      binding: proposalBinding,
      action: "inputText",
      text: "${plannerSecret}",
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toThrow(/unsupported generation variable/i);
  });

  it.each([
    "${run${runId}}",
    "${runId",
    "${runId}}",
    "${}"
  ])("rejects nested or malformed template output %s", (text) => {
    expect(() => expandProposedStepVariables({
      binding: proposalBinding,
      action: "inputText",
      text,
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toThrow(/template marker/i);
  });
});
