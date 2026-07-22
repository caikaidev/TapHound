import { describe, expect, it } from "vitest";

import {
  GENERATION_ERROR_CODES,
  GenerationSessionSchema,
  bindGenerationVariables,
  expandProposedStepVariables,
  generationCoreIdentity
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

const proposalBinding = {
  generationId: "generation-1",
  baseRevision: 1,
  snapshotHash: "b".repeat(64)
};

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
    variables,
    candidateSteps: [{
      binding: proposalBinding,
      action: "wait",
      activity: { before: "com.example.app.MainActivity" }
    }],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" }
  };
}

describe("generation error contract", () => {
  it("defines generation-only error codes", () => {
    expect(GENERATION_ERROR_CODES).toEqual([
      "CONTEXT_INVALID",
      "CONTEXT_STALE",
      "SNAPSHOT_STALE",
      "PACKAGE_ESCAPE",
      "ACTION_UNSUPPORTED",
      "RISK_CONFIRMATION_REQUIRED",
      "ACTION_FORBIDDEN",
      "EXPECT_UNSUPPORTED",
      "RECOVERY_REQUIRED"
    ]);
  });
});

describe("GenerationSessionSchema", () => {
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
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) },
      pendingConfirmation: {
        stepIndex: 0,
        reason: "Back may leave the current screen"
      }
    })).toThrow(/inFlight.*pendingConfirmation/i);
  });

  it("requires recoveryRequired state to retain inFlight evidence", () => {
    expect(GenerationSessionSchema.parse({
      ...(validSession() as object),
      state: "recoveryRequired",
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
    })).toMatchObject({
      state: "recoveryRequired",
      inFlight: { stepIndex: 0 }
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
        journeyPath: "journeys/generated.json"
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
      verification: { status: "passed" },
      publication: { status: "published", journeyPath }
    })).toThrow(/within the project/i);
  });

  it("normalizes a safe publication journey path", () => {
    const parsed = GenerationSessionSchema.parse({
      ...(validSession() as object),
      verification: { status: "passed" },
      publication: {
        status: "published",
        journeyPath: String.raw`journeys\generated.json`
      }
    });

    expect(parsed.publication).toEqual({
      status: "published",
      journeyPath: "journeys/generated.json"
    });
  });

  it("rejects verification while a candidate step is active", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) },
      verification: { status: "running" }
    })).toThrow(/verification/i);
  });

  it("rejects state references outside candidate steps", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      inFlight: { stepIndex: 1, snapshotHash: "b".repeat(64) }
    })).toThrow(/candidate/i);
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
