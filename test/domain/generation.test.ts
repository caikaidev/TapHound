import { describe, expect, it } from "vitest";

import {
  GENERATION_ERROR_CODES,
  GenerationSessionSchema,
  bindGenerationVariables,
  expandProposedStepVariables
} from "../../src/domain/generation.js";

const hashes = {
  contextHash: "a".repeat(64),
  snapshotHash: "b".repeat(64)
};

const variables = {
  runId: "run-42",
  timestamp: "2026-07-22T12:00:00.000Z",
  randomHex: "c0ffee"
};

function validSession(): unknown {
  return {
    version: 1,
    revision: 0,
    bindings: hashes,
    variables,
    candidateSteps: [{
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

  it("rejects unknown fields", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      plannerConfidence: 0.99
    })).toThrow();
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

  it("rejects publication before successful verification", () => {
    expect(() => GenerationSessionSchema.parse({
      ...(validSession() as object),
      publication: {
        status: "published",
        journeyPath: "journeys/generated.json"
      }
    })).toThrow(/verification/i);
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
      action: "inputText",
      text: "run=${runId};time=${timestamp};nonce=${randomHex}",
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toEqual({
      action: "inputText",
      text: "run=run-42;time=2026-07-22T12:00:00.000Z;nonce=c0ffee",
      activity: { before: "com.example.app.MainActivity" }
    });
  });

  it("rejects unbound variable references", () => {
    expect(() => expandProposedStepVariables({
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
      action: "inputText",
      text,
      activity: { before: "com.example.app.MainActivity" }
    }, variables)).toThrow(/template marker/i);
  });
});
