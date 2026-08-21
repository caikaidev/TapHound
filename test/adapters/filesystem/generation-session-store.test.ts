import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";
import { contextSelection } from "../../fixtures/project-context.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-generation-store-"));
  roots.push(root);
  return root;
}

function generationRoot(root: string): string {
  return join(root, ".taphound", "build", "generations");
}

function activeDirectory(root: string): string {
  return join(generationRoot(root), ".generation-1.work");
}

function lockDirectory(root: string): string {
  return join(generationRoot(root), ".locks", "generation-1.lock");
}

async function writeLockOwner(
  root: string,
  pid: number,
  token = "other-owner"
): Promise<void> {
  await mkdir(join(generationRoot(root), ".locks"), { recursive: true });
  await writeFile(
    lockDirectory(root),
    `${JSON.stringify({ pid, token }, null, 2)}\n`,
    { flag: "wx" }
  );
}

function validSession(
  revision = 0,
  overrides: Partial<GenerationSession> = {}
): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision,
    state: "active",
    bindings: {
      projectHash: "d".repeat(64),
      configHash: "e".repeat(64),
      contextHash: "a".repeat(64),
      snapshotHash: "b".repeat(64)
    },
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
    variables: {
      runId: "journey-run-42",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    ...overrides
  };
}

function pendingConfirmation(challengeId: string): NonNullable<
  GenerationSession["pendingConfirmation"]
> {
  return {
    challengeId,
    stepIndex: 0,
    proposalHash: "c".repeat(64),
    snapshotHash: "b".repeat(64),
    evidenceHash: "e".repeat(64),
    actionSummary: "Back from com.example.app.MainActivity",
    expiresAt: "2026-07-22T12:00:30.000Z",
    status: "pending"
  };
}

function successfulWaitStep(): GenerationSession["candidateSteps"][number] {
  return {
    action: "wait",
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.MainActivity"
    }
  };
}

function verificationCandidate(
  revision = 0,
  overrides: Partial<GenerationSession> = {}
): GenerationSession {
  return validSession(revision, {
    candidateSteps: [successfulWaitStep()],
    candidateSources: ["planner"],
    ...overrides
  });
}

async function markPublishable(
  store: FileSystemGenerationSessionStore,
  initial: GenerationSession
): Promise<GenerationSession> {
  const running = await store.beginVerification(
    initial.id,
    initial.revision,
    "verification-attempt"
  );
  const passed = {
    ...running,
    revision: running.revision + 1,
    verification: {
      status: "passed" as const,
      attemptId: "verification-attempt",
      reportPath: "verification/report.json",
      reportSha256: "f".repeat(64),
      runId: "verification-run"
    }
  };
  await store.completeVerification(running.id, running.revision, passed);
  const publishable = {
    ...passed,
    revision: passed.revision + 1,
    publication: {
      status: "published" as const,
      journeyPath: ".taphound/journeys/generated.json"
    }
  };
  await store.markBundlePublishable(
    passed.id,
    passed.revision,
    publishable
  );
  return publishable;
}

function expectStoreError(
  promise: Promise<unknown>,
  code: GenerationSessionStoreError["code"]
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "GenerationSessionStoreError",
    code
  });
}

function expectSynchronousStoreError(
  operation: () => unknown,
  code: GenerationSessionStoreError["code"]
): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "GenerationSessionStoreError",
      code
    });
  }
}

describe("FileSystemGenerationSessionStore", () => {
  it("creates and reads a validated active session", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const session = validSession();

    await store.create(session);

    await expect(store.read("generation-1")).resolves.toEqual(session);
    await expect(readFile(join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work",
      "state.json"
    ), "utf8")).resolves.toBe(`${JSON.stringify(session, null, 2)}\n`);
  });

  it("rejects duplicate active and published session creation", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = verificationCandidate();
    await store.create(initial);

    await expectStoreError(
      store.create(validSession()),
      "SESSION_ALREADY_EXISTS"
    );

    await markPublishable(store, initial);
    await store.publish("generation-1");
    await expectStoreError(
      store.create(validSession()),
      "SESSION_ALREADY_EXISTS"
    );
  });

  it("rejects nonzero initial revisions and malformed sessions", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);

    await expectStoreError(
      store.create(validSession(1)),
      "INVALID_REVISION"
    );
    await expectStoreError(
      store.create({
        ...validSession(),
        unexpected: true
      } as GenerationSession),
      "INVALID_SESSION"
    );
    await expectStoreError(
      store.create({
        variables: null
      } as unknown as GenerationSession),
      "INVALID_SESSION"
    );
  });

  it("maps filesystem failures to IO_ERROR without treating them as invalid content", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await unlink(join(activeDirectory(root), "state.json"));

    await expectStoreError(store.read("generation-1"), "IO_ERROR");

    const notDirectory = join(root, "not-a-project");
    await writeFile(notDirectory, "file", "utf8");
    const invalidRootStore = new FileSystemGenerationSessionStore(
      notDirectory
    );
    await expectStoreError(
      invalidRootStore.read("generation-1"),
      "IO_ERROR"
    );
  });

  it("updates state only when the expected and next revisions are exact", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    const next = validSession(1, {
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    });
    await store.update("generation-1", 0, next);

    await expect(store.read("generation-1")).resolves.toEqual(next);
    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "REVISION_CONFLICT"
    );
    await expectStoreError(
      store.update("generation-1", 1, validSession(3)),
      "INVALID_REVISION"
    );
    await expectStoreError(
      store.update("generation-1", -1, validSession(0)),
      "INVALID_REVISION"
    );
    await expectStoreError(
      store.update("generation-1", 1, {
        ...validSession(2),
        id: "different-generation"
      }),
      "INVALID_ID"
    );
  });

  it("CAS-commits only the authoritative snapshot binding", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession(0, {
      bindings: {
        projectHash: "d".repeat(64),
        configHash: "e".repeat(64),
        contextHash: "a".repeat(64),
        snapshotHash: null
      }
    }));
    const committed = validSession(1, {
      bindings: {
        projectHash: "d".repeat(64),
        configHash: "e".repeat(64),
        contextHash: "a".repeat(64),
        snapshotHash: "c".repeat(64)
      }
    });

    await store.commitSnapshot("generation-1", 0, committed);
    await expect(store.read("generation-1")).resolves.toEqual(committed);
    await expectStoreError(
      store.commitSnapshot("generation-1", 0, committed),
      "REVISION_CONFLICT"
    );
    await expectStoreError(store.commitSnapshot(
      "generation-1",
      1,
      validSession(2, {
        variables: {
          ...validSession().variables,
          randomHex: "bad0"
        }
      })
    ), "INVALID_TRANSITION");
  });

  it("atomically begins a safe step without changing candidate or Core state", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = validSession();
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(initial);

    const begun = await store.beginStep("generation-1", 0, inFlight);

    expect(begun).toEqual({
      ...initial,
      revision: 1,
      inFlight
    });
    await expect(store.read("generation-1")).resolves.toEqual(begun);
  });

  it("consumes only the exact approved confirmation when beginning a step", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root, {
      now: (): Date => new Date("2026-07-22T12:00:00.000Z")
    });
    const approved = {
      ...pendingConfirmation("challenge-1"),
      status: "approved" as const,
      approvalMode: "delegated" as const
    };
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1",
      confirmation: {
        challengeId: "challenge-1",
        approvalMode: "delegated" as const
      }
    };
    await store.create(validSession(0, {
      pendingConfirmation: approved
    }));

    await expectStoreError(
      store.beginStep("generation-1", 0, inFlight),
      "INVALID_TRANSITION"
    );
    await expectStoreError(
      store.beginStep("generation-1", 0, inFlight, {
        ...approved,
        challengeId: "challenge-2"
      }),
      "INVALID_TRANSITION"
    );
    await expectStoreError(
      store.beginStep("generation-1", 0, inFlight, {
        ...approved,
        evidenceHash: "d".repeat(64)
      }),
      "INVALID_TRANSITION"
    );
    const begun = await store.beginStep(
      "generation-1",
      0,
      inFlight,
      approved
    );
    expect(begun).toMatchObject({
      revision: 1,
      inFlight,
      pendingConfirmation: null,
      candidateSteps: [],
      candidateSources: []
    });
  });

  it("rejects a confirmation that expires inside the beginStep lock", async () => {
    const root = await temporaryRoot();
    let now = new Date("2026-07-22T12:00:00.000Z");
    const store = new FileSystemGenerationSessionStore(root, {
      now: (): Date => now,
      hooks: {
        beforeStateRename: (): void => {
          now = new Date("2026-07-22T12:00:31.000Z");
        }
      }
    });
    const approved = {
      ...pendingConfirmation("challenge-1"),
      status: "approved" as const,
      approvalMode: "localTty" as const
    };
    const initial = validSession(0, { pendingConfirmation: approved });
    await store.create(initial);
    now = new Date("2026-07-22T12:00:00.000Z");

    await expectStoreError(store.beginStep("generation-1", 0, {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1",
      confirmation: {
        challengeId: "challenge-1",
        approvalMode: "localTty"
      }
    }, approved), "INVALID_TRANSITION");
    await expect(store.read("generation-1")).resolves.toEqual(initial);
  });

  it("rejects a recovered retry whose attempt evidence namespace exists", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = validSession();
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(initial);
    const begun = await store.beginStep("generation-1", 0, inFlight);
    await store.writeTextEvidence(
      "generation-1",
      "evidence/steps/0-attempt-1/logcat.txt",
      "first attempt\n"
    );
    const recoveryRequired = {
      ...begun,
      revision: 2,
      state: "recoveryRequired" as const
    };
    await store.update("generation-1", 1, recoveryRequired);
    const recovered = {
      ...recoveryRequired,
      revision: 3,
      state: "active" as const,
      inFlight: null
    };
    await store.recover("generation-1", 2, recovered);

    await expectStoreError(
      store.beginStep("generation-1", 3, inFlight),
      "EVIDENCE_ALREADY_EXISTS"
    );
    await expect(store.read("generation-1")).resolves.toEqual(recovered);
  });

  it("reserves one revision after begin for completion or recovery", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const state = validSession(Number.MAX_SAFE_INTEGER - 1);
    await writeFile(
      join(activeDirectory(root), "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8"
    );

    await expectStoreError(store.beginStep(
      "generation-1",
      Number.MAX_SAFE_INTEGER - 1,
      {
        stepIndex: 0,
        snapshotHash: "b".repeat(64),
        proposalHash: "c".repeat(64),
        attemptId: "attempt-1"
      }
    ), "INVALID_REVISION");
    await expect(store.read("generation-1")).resolves.toEqual(state);
  });

  it("reserves verification completion and publication revisions", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(verificationCandidate());
    const state = verificationCandidate(Number.MAX_SAFE_INTEGER - 2);
    await writeFile(
      join(activeDirectory(root), "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8"
    );

    await expectStoreError(store.beginVerification(
      "generation-1",
      Number.MAX_SAFE_INTEGER - 2,
      "verification-attempt"
    ), "INVALID_REVISION");
    await expect(store.read("generation-1")).resolves.toEqual(state);
  });

  it("forbids ordinary update from mutating verification or publication", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = verificationCandidate();
    await store.create(initial);

    await expectStoreError(store.update(
      "generation-1",
      0,
      verificationCandidate(1, {
        verification: {
          status: "running",
          attemptId: "verification-attempt"
        }
      })
    ), "INVALID_TRANSITION");
    await expect(store.read("generation-1")).resolves.toEqual(initial);
  });

  it("starts inFlight without mutating candidate or result state", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };

    await expectStoreError(store.update("generation-1", 0, validSession(1, {
      candidateSteps: [{
        action: "back",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      }],
      inFlight
    })), "INVALID_SESSION");
    const begun = validSession(1, { inFlight });
    await store.update("generation-1", 0, begun);
    await expect(store.read("generation-1")).resolves.toEqual(begun);
    await expectStoreError(store.update("generation-1", 1, validSession(2, {
      candidateSteps: [{
        action: "back",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      }],
      inFlight
    })), "INVALID_SESSION");
  });

  it("rejects fabricated recovery from a session without inFlight", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(store.update("generation-1", 0, validSession(1, {
      state: "recoveryRequired",
      inFlight: {
        stepIndex: 0,
        snapshotHash: "b".repeat(64),
        proposalHash: "c".repeat(64),
        attemptId: "attempt-1"
      }
    })), "INVALID_TRANSITION");
  });

  it.each([
    ["bindings", {
      bindings: {
        projectHash: "d".repeat(64),
        configHash: "e".repeat(64),
        contextHash: "c".repeat(64),
        snapshotHash: "b".repeat(64)
      }
    }],
    ["variables", {
      variables: {
        runId: "other-run",
        timestamp: "2026-07-22T12:00:00.000Z",
        randomHex: "c0ffee"
      }
    }],
    ["candidate steps", {
      candidateSteps: [{
        action: "back",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.MainActivity"
        }
      }]
    }]
  ] satisfies [string, Partial<GenerationSession>][])(
    "rejects %s mutation while marking inFlight recovery",
    async (_field, mutation) => {
      const root = await temporaryRoot();
      const store = new FileSystemGenerationSessionStore(root);
      const inFlight = {
        stepIndex: 0,
        snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
      };
      await store.create(validSession(0, { inFlight }));

      await expectStoreError(store.update(
        "generation-1",
        0,
        validSession(1, {
          state: "recoveryRequired",
          inFlight,
          ...mutation
        })
      ), _field === "candidate steps"
        ? "INVALID_SESSION"
        : "INVALID_TRANSITION");
    }
  );

  it("requires an explicit recovery transition for persisted inFlight state", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = validSession(0, {
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    });

    await store.create(inFlight);

    await expect(store.read("generation-1")).resolves.toEqual(inFlight);
    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "INVALID_TRANSITION"
    );
    await expectStoreError(
      store.update("generation-1", 0, validSession(1, {
        inFlight: { stepIndex: 0, snapshotHash: "c".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
      })),
      "INVALID_TRANSITION"
    );

    const recoveryRequired = validSession(1, {
      state: "recoveryRequired",
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    });
    await store.update("generation-1", 0, recoveryRequired);
    await expectStoreError(
      store.update("generation-1", 1, validSession(2)),
      "INVALID_TRANSITION"
    );

    const recovered = validSession(2);
    await store.recover("generation-1", 1, recovered);
    await expect(store.read("generation-1")).resolves.toEqual(recovered);
  });

  it("explicitly resets only an interrupted running verification", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(verificationCandidate());
    const running = await store.beginVerification(
      "generation-1",
      0,
      "verification-attempt",
      {
        pid: 1234,
        startedAt: "2026-08-20T00:00:00.000Z"
      }
    );
    const recovered = {
      ...running,
      revision: running.revision + 1,
      verification: { status: "notRun" as const }
    };

    await store.recoverVerification(
      "generation-1",
      running.revision,
      recovered
    );

    await expect(store.read("generation-1")).resolves.toEqual(recovered);
  });

  it("rejects verification recovery after immutable evidence exists", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(verificationCandidate());
    const running = await store.beginVerification(
      "generation-1",
      0,
      "verification-attempt",
      { pid: 1234, startedAt: "2026-08-20T00:00:00.000Z" }
    );
    await store.writeEvidence(
      "generation-1",
      "verification/receipt.json",
      { status: "passed" }
    );

    await expectStoreError(
      store.recoverVerification(
        "generation-1",
        running.revision,
        {
          ...running,
          revision: running.revision + 1,
          verification: { status: "notRun" }
        }
      ),
      "INVALID_TRANSITION"
    );
  });

  it("rejects recovery unless only recovery state and inFlight are cleared", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await expectStoreError(
      store.recover("generation-1", 0, validSession(1)),
      "INVALID_TRANSITION"
    );

    await store.update("generation-1", 0, validSession(1, {
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    }));
    await store.update("generation-1", 1, validSession(2, {
      state: "recoveryRequired",
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64), proposalHash: "c".repeat(64), attemptId: "attempt-1" }
    }));
    await expectStoreError(
      store.recover("generation-1", 2, validSession(3, {
        candidateSteps: [{
          action: "back",
          activity: {
            before: "com.example.app.MainActivity",
            after: "com.example.app.MainActivity"
          }
        }],
        candidateSources: ["planner"]
      })),
      "INVALID_TRANSITION"
    );
  });

  it("atomically completes the matching inFlight step with candidate changes", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(validSession(0, { inFlight }));
    const completed = validSession(1, {
      candidateSteps: [{
        action: "wait",
        activity: {
          before: "com.example.app.MainActivity",
          after: "com.example.app.CompletedActivity"
        }
      }],
      candidateSources: ["planner"],
      inFlight: null
    });

    await expectStoreError(store.completeStep(
      "generation-1",
      0,
      inFlight,
      validSession(1)
    ), "INVALID_TRANSITION");
    await store.completeStep(
      "generation-1",
      0,
      inFlight,
      completed
    );

    await expect(store.read("generation-1")).resolves.toEqual(completed);
  });

  it.each([
    "begin",
    "markRecovery",
    "completeStep",
    "recover",
    "commitSnapshot"
  ] as const)("preserves immutable Core identity during %s", async (
    transition
  ) => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    const changedTarget = {
      ...validSession().target,
      deviceSerial: "different-device"
    };

    if (transition === "begin") {
      await store.create(validSession());
      await expectStoreError(store.update(
        "generation-1",
        0,
        validSession(1, { inFlight, target: changedTarget })
      ), "INVALID_TRANSITION");
      return;
    }
    if (transition === "markRecovery") {
      await store.create(validSession(0, { inFlight }));
      await expectStoreError(store.update(
        "generation-1",
        0,
        validSession(1, {
          state: "recoveryRequired",
          inFlight,
          target: changedTarget
        })
      ), "INVALID_TRANSITION");
      return;
    }
    if (transition === "completeStep") {
      await store.create(validSession(0, { inFlight }));
      await expectStoreError(store.completeStep(
        "generation-1",
        0,
        inFlight,
        validSession(1, { target: changedTarget })
      ), "INVALID_TRANSITION");
      return;
    }
    if (transition === "recover") {
      await store.create(validSession(0, {
        state: "recoveryRequired",
        inFlight
      }));
      await expectStoreError(store.recover(
        "generation-1",
        0,
        validSession(1, { target: changedTarget })
      ), "INVALID_TRANSITION");
      return;
    }

    await store.create(validSession(0, {
      bindings: {
        ...validSession().bindings,
        snapshotHash: null
      }
    }));
    await expectStoreError(store.commitSnapshot(
      "generation-1",
      0,
      validSession(1, {
        bindings: {
          ...validSession().bindings,
          snapshotHash: "c".repeat(64)
        },
        target: changedTarget
      })
    ), "INVALID_TRANSITION");
  });

  it("completeStep preserves the pre-action latest snapshot reference", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(validSession(0, { inFlight }));

    await expectStoreError(store.completeStep(
      "generation-1",
      0,
      inFlight,
      validSession(1, {
        bindings: {
          ...validSession().bindings,
          snapshotHash: "c".repeat(64)
        }
      })
    ), "INVALID_TRANSITION");
  });

  it("rejects latest snapshot changes through ordinary idle updates", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(store.update(
      "generation-1",
      0,
      validSession(1, {
        bindings: {
          ...validSession().bindings,
          snapshotHash: "c".repeat(64)
        }
      })
    ), "INVALID_TRANSITION");
  });

  it("rejects completeStep for mismatched inFlight and stale revisions", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(validSession(0, { inFlight }));

    await expectStoreError(store.completeStep(
      "generation-1",
      0,
      { ...inFlight, snapshotHash: "c".repeat(64) },
      validSession(1)
    ), "INVALID_TRANSITION");
    await store.completeStep(
      "generation-1",
      0,
      inFlight,
      validSession(1, {
        candidateSteps: [successfulWaitStep()],
        candidateSources: ["planner"]
      })
    );
    await expectStoreError(store.completeStep(
      "generation-1",
      0,
      inFlight,
      validSession(1, {
        candidateSteps: [successfulWaitStep()],
        candidateSources: ["planner"]
      })
    ), "REVISION_CONFLICT");
  });

  it("keeps completeStep separate from interrupted recovery", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = {
      stepIndex: 0,
      snapshotHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      attemptId: "attempt-1"
    };
    await store.create(validSession(0, { inFlight }));
    const recoveryRequired = validSession(1, {
      state: "recoveryRequired",
      inFlight
    });
    await store.update("generation-1", 0, recoveryRequired);

    await expectStoreError(store.completeStep(
      "generation-1",
      1,
      inFlight,
      validSession(2)
    ), "INVALID_TRANSITION");
    await store.recover("generation-1", 1, validSession(2));
    await expect(store.read("generation-1")).resolves.toEqual(
      validSession(2)
    );
  });

  it("rejects revision increments beyond Number.MAX_SAFE_INTEGER", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const statePath = join(activeDirectory(root), "state.json");
    await writeFile(statePath, `${JSON.stringify(validSession(
      Number.MAX_SAFE_INTEGER
    ), null, 2)}\n`, "utf8");

    await expectStoreError(
      store.update(
        "generation-1",
        Number.MAX_SAFE_INTEGER,
        validSession(Number.MAX_SAFE_INTEGER)
      ),
      "INVALID_REVISION"
    );
  });

  it("allows only one concurrent writer for the same revision", async () => {
    const root = await temporaryRoot();
    const firstStore = new FileSystemGenerationSessionStore(root);
    const secondStore = new FileSystemGenerationSessionStore(root);
    await firstStore.create(validSession());

    const results = await Promise.allSettled([
      firstStore.updateConfirmation("generation-1", 0, validSession(1, {
        pendingConfirmation: pendingConfirmation("confirm-one")
      })),
      secondStore.updateConfirmation("generation-1", 0, validSession(1, {
        pendingConfirmation: pendingConfirmation("confirm-two")
      }))
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        name: "GenerationSessionStoreError",
        code: "REVISION_CONFLICT"
      }
    });
    expect((await firstStore.read("generation-1")).revision).toBe(1);
  });

  it("persists only the pending-to-approved-to-cleared confirmation lifecycle", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const pending = pendingConfirmation("challenge-1");
    const challenged = validSession(1, { pendingConfirmation: pending });

    await store.updateConfirmation("generation-1", 0, challenged);
    await expectStoreError(store.update("generation-1", 1, validSession(2)),
      "INVALID_TRANSITION");

    const approved = validSession(2, {
      pendingConfirmation: {
        ...pending,
        status: "approved",
        approvalMode: "localTty"
      }
    });
    await store.updateConfirmation("generation-1", 1, approved);
    await expectStoreError(store.updateConfirmation(
      "generation-1",
      2,
      validSession(3, {
        pendingConfirmation: {
          ...pending,
          status: "approved",
          approvalMode: "localTty"
        }
      })
    ), "INVALID_TRANSITION");

    const cleared = validSession(3);
    await store.updateConfirmation("generation-1", 2, cleared);
    await expect(store.read("generation-1")).resolves.toEqual(cleared);
  });

  it("rejects replacing a pending challenge or mutating Core identity", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const pending = pendingConfirmation("challenge-1");
    await store.create(validSession(0, { pendingConfirmation: pending }));

    await expectStoreError(store.updateConfirmation(
      "generation-1",
      0,
      validSession(1, {
        pendingConfirmation: pendingConfirmation("challenge-2")
      })
    ), "INVALID_TRANSITION");
    await expectStoreError(store.updateConfirmation(
      "generation-1",
      0,
      validSession(1, {
        pendingConfirmation: null,
        target: {
          ...validSession().target,
          deviceSerial: "other-device"
        }
      })
    ), "INVALID_TRANSITION");
  });

  it("ignores an interrupted temporary state file", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const workDirectory = join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work"
    );
    await writeFile(
      join(workDirectory, ".state.json.interrupted.tmp"),
      "{\"revision\":999",
      "utf8"
    );

    await expect(store.read("generation-1")).resolves.toEqual(validSession());
    await store.update("generation-1", 0, validSession(1));
    await expect(readdir(workDirectory)).resolves.toContain(
      ".state.json.interrupted.tmp"
    );
  });

  it("rejects generation-root substitution during lock installation", async () => {
    const root = await temporaryRoot();
    let substituteRoot = false;
    const generations = generationRoot(root);
    const movedGenerations = `${generations}.moved`;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforeLockInstall: async (): Promise<void> => {
          if (substituteRoot) {
            substituteRoot = false;
            await rename(generations, movedGenerations);
            await mkdir(join(generations, ".locks"), { recursive: true });
          }
        }
      }
    });
    await store.create(validSession());
    substituteRoot = true;

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "IO_ERROR"
    );
    await expect(readFile(join(
      movedGenerations,
      ".generation-1.work",
      "state.json"
    ), "utf8")).resolves.toContain('"revision": 0');
  });

  it("rejects active-bundle substitution after opening state", async () => {
    const root = await temporaryRoot();
    let substituteBundle = false;
    const active = activeDirectory(root);
    const movedActive = `${active}.moved`;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterStateOpen: async (): Promise<void> => {
          if (substituteBundle) {
            substituteBundle = false;
            await rename(active, movedActive);
            await mkdir(active);
            await writeFile(
              join(active, "state.json"),
              `${JSON.stringify(validSession(9), null, 2)}\n`,
              "utf8"
            );
          }
        }
      }
    });
    await store.create(validSession());
    substituteBundle = true;

    await expectStoreError(store.read("generation-1"), "IO_ERROR");
  });

  it("rejects state-file substitution after opening its descriptor", async () => {
    const root = await temporaryRoot();
    let substituteState = false;
    const statePath = join(activeDirectory(root), "state.json");
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterStateOpen: async (): Promise<void> => {
          if (substituteState) {
            substituteState = false;
            await rename(statePath, `${statePath}.moved`);
            await writeFile(
              statePath,
              `${JSON.stringify(validSession(9), null, 2)}\n`,
              "utf8"
            );
          }
        }
      }
    });
    await store.create(validSession());
    substituteState = true;

    await expectStoreError(store.read("generation-1"), "IO_ERROR");
  });

  it("rejects active-bundle substitution before state rename", async () => {
    const root = await temporaryRoot();
    let substituteBundle = false;
    const active = activeDirectory(root);
    const movedActive = `${active}.moved`;
    const replacement = validSession(9);
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforeStateRename: async (): Promise<void> => {
          if (substituteBundle) {
            substituteBundle = false;
            await rename(active, movedActive);
            await mkdir(active);
            await writeFile(
              join(active, "state.json"),
              `${JSON.stringify(replacement, null, 2)}\n`,
              "utf8"
            );
          }
        }
      }
    });
    await store.create(validSession());
    substituteBundle = true;

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "IO_ERROR"
    );
    await expect(readFile(join(active, "state.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(replacement, null, 2)}\n`
    );
  });

  it("never reclaims a long-lived lock owned by a live PID", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root, {
      lockTimeoutMs: 30,
      lockRetryMs: 5
    });
    await store.create(validSession());
    await writeLockOwner(root, process.pid);

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "LOCK_TIMEOUT"
    );
    await expect(readFile(join(
      lockDirectory(root)
    ), "utf8")).resolves.toContain(`"pid": ${String(process.pid)}`);
  });

  it("atomically reaps a lock owned by a dead PID", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root, {
      lockTimeoutMs: 100,
      lockRetryMs: 5
    });
    await store.create(validSession());
    await writeLockOwner(root, 2_147_483_647, "dead-owner");

    await store.update("generation-1", 0, validSession(1));

    await expect(stat(lockDirectory(root))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect((await readdir(join(generationRoot(root), ".locks"))).filter(
      (name) => name.includes(".reap-")
    )).toEqual([]);
  });

  it("does not delete a replacement lock created after dead-owner reap", async () => {
    const root = await temporaryRoot();
    let replacementCreated = false;
    const store = new FileSystemGenerationSessionStore(root, {
      lockTimeoutMs: 40,
      lockRetryMs: 5,
      hooks: {
        afterLockTombstoneRename: async (): Promise<void> => {
          if (!replacementCreated) {
            replacementCreated = true;
            await writeLockOwner(root, process.pid, "replacement-owner");
          }
        }
      }
    });
    await store.create(validSession());
    await writeLockOwner(root, 2_147_483_647, "dead-owner");

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "LOCK_TIMEOUT"
    );
    await expect(readFile(
      lockDirectory(root),
      "utf8"
    )).resolves.toContain("replacement-owner");
  });

  it("ignores partial operation-owned lock staging files after a crash", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const locksRoot = join(generationRoot(root), ".locks");
    const interrupted = join(
      locksRoot,
      ".generation-1.lock.acquire-interrupted.tmp"
    );
    await writeFile(interrupted, "{\"pid\":", "utf8");

    await store.update("generation-1", 0, validSession(1));

    await expect(readFile(interrupted, "utf8")).resolves.toBe("{\"pid\":");
    await expect(stat(lockDirectory(root))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("cleans only its lock staging file after owner write failure", async () => {
    const root = await temporaryRoot();
    let failWrite = false;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforeLockStagingWrite: (): void => {
          if (failWrite) {
            failWrite = false;
            throw new Error("simulated lock owner write failure");
          }
        }
      }
    });
    await store.create(validSession());
    failWrite = true;

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "IO_ERROR"
    );
    expect((await readdir(join(generationRoot(root), ".locks"))).filter(
      (name) => name.includes(".acquire-")
    )).toEqual([]);
    await store.update("generation-1", 0, validSession(1));
  });

  it("preserves a competing lock installed before canonical hard-link", async () => {
    const root = await temporaryRoot();
    let installReplacement = false;
    const store = new FileSystemGenerationSessionStore(root, {
      lockTimeoutMs: 35,
      lockRetryMs: 5,
      hooks: {
        beforeLockInstall: async (): Promise<void> => {
          if (installReplacement) {
            installReplacement = false;
            await writeLockOwner(
              root,
              process.pid,
              "install-race-owner"
            );
          }
        }
      }
    });
    await store.create(validSession());
    installReplacement = true;

    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "LOCK_TIMEOUT"
    );
    await expect(readFile(lockDirectory(root), "utf8")).resolves.toContain(
      "install-race-owner"
    );
  });

  it("writes immutable evidence with canonical JSON", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await store.writeEvidence(
      "generation-1",
      "evidence/revision-000/proposal.json",
      { z: 1, a: { y: 2, b: 3 } }
    );

    const evidencePath = join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work",
      "evidence",
      "revision-000",
      "proposal.json"
    );
    await expect(readFile(evidencePath, "utf8")).resolves.toBe(
      '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n'
    );
    await expectStoreError(
      store.writeEvidence(
        "generation-1",
        "evidence/revision-000/proposal.json",
        { replacement: true }
      ),
      "EVIDENCE_ALREADY_EXISTS"
    );
    await expect(readFile(evidencePath, "utf8")).resolves.not.toContain(
      "replacement"
    );
  });

  it("writes immutable text evidence without exposing a producer path", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await store.writeTextEvidence(
      "generation-1",
      "evidence/steps/001-logcat.txt",
      "line one\nline two\n"
    );

    await expect(readFile(join(
      activeDirectory(root),
      "evidence",
      "steps",
      "001-logcat.txt"
    ), "utf8")).resolves.toBe("line one\nline two\n");
    await expectStoreError(store.writeTextEvidence(
      "generation-1",
      "evidence/steps/001-logcat.txt",
      "replacement"
    ), "EVIDENCE_ALREADY_EXISTS");
  });

  it("installs immutable binary evidence through a Store-owned producer path", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    let producerPath = "";

    await store.produceEvidence(
      "generation-1",
      "evidence/snapshots/revision-000001/screen.png",
      async (temporaryPath) => {
        producerPath = temporaryPath;
        await writeFile(temporaryPath, Buffer.from([0, 1, 2, 255]));
      }
    );

    expect(producerPath.startsWith(`${activeDirectory(root)}/`)).toBe(true);
    await expect(readFile(join(
      activeDirectory(root),
      "evidence",
      "snapshots",
      "revision-000001",
      "screen.png"
    ))).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
    await expectStoreError(store.produceEvidence(
      "generation-1",
      "evidence/snapshots/revision-000001/screen.png",
      async (temporaryPath) => {
        await writeFile(temporaryPath, "replacement");
      }
    ), "EVIDENCE_ALREADY_EXISTS");
  });

  it("cleans only its producer temporary file after producer failure", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const interrupted = join(activeDirectory(root), ".evidence-unrelated.tmp");
    await writeFile(interrupted, "preserve me");

    await expect(store.produceEvidence(
      "generation-1",
      "evidence/snapshots/revision-000001/screen.png",
      async (temporaryPath) => {
        await writeFile(temporaryPath, "partial");
        throw new Error("capture failed");
      }
    )).rejects.toMatchObject({
      name: "GenerationSessionStoreError",
      code: "IO_ERROR"
    });

    await expect(readFile(interrupted, "utf8")).resolves.toBe("preserve me");
    expect((await readdir(activeDirectory(root))).filter(
      (name) => name.startsWith(".producer-")
    )).toEqual([]);
    await expect(readFile(join(
      activeDirectory(root),
      "evidence",
      "snapshots",
      "revision-000001",
      "screen.png"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects evidence writes when persisted state has another session id", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await writeFile(
      join(activeDirectory(root), "state.json"),
      `${JSON.stringify({
        ...validSession(),
        id: "different-generation"
      }, null, 2)}\n`,
      "utf8"
    );

    await expectStoreError(store.writeEvidence(
      "generation-1",
      "evidence/result.json",
      {}
    ), "INVALID_SESSION");
    await expect(readdir(activeDirectory(root))).resolves.toEqual([
      "state.json"
    ]);
  });

  it("creates no evidence after the active bundle is renamed during state read", async () => {
    const root = await temporaryRoot();
    const active = activeDirectory(root);
    const movedActive = `${active}.moved`;
    let renameBundle = false;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterStateOpen: async (): Promise<void> => {
          if (renameBundle) {
            renameBundle = false;
            await rename(active, movedActive);
            await mkdir(active);
            await writeFile(
              join(active, "state.json"),
              `${JSON.stringify(validSession(), null, 2)}\n`,
              "utf8"
            );
          }
        }
      }
    });
    await store.create(validSession());
    renameBundle = true;

    await expectStoreError(store.writeEvidence(
      "generation-1",
      "evidence/result.json",
      {}
    ), "IO_ERROR");
    await expect(readdir(active)).resolves.toEqual(["state.json"]);
    await expect(readdir(movedActive)).resolves.toEqual(["state.json"]);
  });

  it("retries evidence after a crash before atomic installation", async () => {
    const root = await temporaryRoot();
    let failBeforeInstall = true;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforeEvidenceInstall: (): void => {
          if (failBeforeInstall) {
            failBeforeInstall = false;
            throw new Error("simulated pre-install crash");
          }
        }
      }
    });
    await store.create(validSession());

    await expectStoreError(
      store.writeEvidence("generation-1", "evidence/result.json", {
        complete: true
      }),
      "IO_ERROR"
    );
    expect((await readdir(activeDirectory(root))).filter(
      (name) => name.includes(".evidence-")
    )).toEqual([]);

    await store.writeEvidence("generation-1", "evidence/result.json", {
      complete: true
    });
    await expect(readFile(
      join(activeDirectory(root), "evidence", "result.json"),
      "utf8"
    )).resolves.toContain('"complete": true');
  });

  it("ignores a truncated temporary evidence file from an interrupted process", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const interrupted = join(
      activeDirectory(root),
      ".evidence-interrupted.tmp"
    );
    await writeFile(interrupted, "{\"truncated\":", "utf8");

    await store.writeEvidence(
      "generation-1",
      "evidence/result.json",
      { complete: true }
    );

    await expect(readFile(
      join(activeDirectory(root), "evidence", "result.json"),
      "utf8"
    )).resolves.toContain('"complete": true');
    await expect(readFile(interrupted, "utf8")).resolves.toBe(
      "{\"truncated\":"
    );
  });

  it("leaves fully installed evidence immutable after interruption", async () => {
    const root = await temporaryRoot();
    let interruptAfterInstall = true;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterEvidenceInstall: (): void => {
          if (interruptAfterInstall) {
            interruptAfterInstall = false;
            throw new Error("simulated post-install crash");
          }
        }
      }
    });
    await store.create(validSession());
    const evidencePath = join(
      activeDirectory(root),
      "evidence",
      "result.json"
    );

    await expectStoreError(
      store.writeEvidence("generation-1", "evidence/result.json", {
        complete: "not-truncated"
      }),
      "IO_ERROR"
    );
    await expect(readFile(evidencePath, "utf8")).resolves.toContain(
      '"complete": "not-truncated"'
    );
    await expectStoreError(
      store.writeEvidence("generation-1", "evidence/result.json", {
        replacement: true
      }),
      "EVIDENCE_ALREADY_EXISTS"
    );
  });

  it("detects evidence parent substitution before installation", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    let substituted = false;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforeEvidenceInstall: async (): Promise<void> => {
          if (!substituted) {
            substituted = true;
            const evidenceDirectory = join(
              activeDirectory(root),
              "evidence"
            );
            await rename(evidenceDirectory, `${evidenceDirectory}.moved`);
            await symlink(outside, evidenceDirectory);
          }
        }
      }
    });
    await store.create(validSession());

    await expectStoreError(
      store.writeEvidence("generation-1", "evidence/result.json", {
        unsafe: true
      }),
      "INVALID_EVIDENCE_PATH"
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("ignores only the ephemeral build subtree on session creation", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);

    await store.create(validSession());

    await expect(
      readFile(join(root, ".taphound", ".gitignore"), "utf8")
    ).resolves.toBe("build/\n");
  });

  it("never overwrites an existing .taphound/.gitignore", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".taphound"));
    await writeFile(
      join(root, ".taphound", ".gitignore"),
      "build/\nruns/\n",
      "utf8"
    );
    const store = new FileSystemGenerationSessionStore(root);

    await store.create(validSession());

    await expect(
      readFile(join(root, ".taphound", ".gitignore"), "utf8")
    ).resolves.toBe("build/\nruns/\n");
  });

  it("syncs the generation root and each newly created evidence ancestor", async () => {
    const root = await temporaryRoot();
    const synced: string[] = [];
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterDirectorySync: (path): void => {
          synced.push(path);
        }
      }
    });

    await store.create(validSession());
    expect(synced).toContain(root);
    expect(synced).toContain(join(root, ".taphound"));
    expect(synced).toContain(join(root, ".taphound", "build"));
    expect(synced).toContain(generationRoot(root));
    synced.length = 0;

    await store.writeEvidence(
      "generation-1",
      "evidence/revision-001/result.json",
      {}
    );
    expect(synced).toEqual(expect.arrayContaining([
      activeDirectory(root),
      join(activeDirectory(root), "evidence"),
      join(activeDirectory(root), "evidence", "revision-001")
    ]));
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
  ])("rejects unsafe session id %s", async (id) => {
    const store = new FileSystemGenerationSessionStore(await temporaryRoot());

    await expectStoreError(store.create({
      ...validSession(),
      id
    }), "INVALID_ID");
    await expectStoreError(store.read(id), "INVALID_ID");
  });

  it.each([
    "",
    ".",
    "..",
    "../outside.json",
    "evidence/../../outside.json",
    "/tmp/outside.json",
    String.raw`C:\outside.json`,
    String.raw`\\server\share\outside.json`,
    String.raw`evidence\..\outside.json`
  ])("rejects unsafe evidence path %s", async (relativePath) => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(
      store.writeEvidence("generation-1", relativePath, { unsafe: true }),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("returns typed errors for hostile and non-string public inputs", async () => {
    const root = await temporaryRoot();
    const hostile = new Proxy({}, {
      get: (): never => {
        throw new Error("hostile getter");
      },
      ownKeys: (): never => {
        throw new Error("hostile ownKeys");
      }
    });
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(
      store.read(hostile as string),
      "INVALID_ID"
    );
    await expectStoreError(
      store.update("generation-1", 0, hostile as GenerationSession),
      "INVALID_SESSION"
    );
    await expectStoreError(
      store.completeStep(
        "generation-1",
        0,
        hostile as GenerationSession["inFlight"] & object,
        validSession(1)
      ),
      "INVALID_TRANSITION"
    );
    await expectStoreError(
      store.writeEvidence(
        "generation-1",
        hostile as string,
        {}
      ),
      "INVALID_EVIDENCE_PATH"
    );
    const evidenceWithThrowingGetter: Record<string, unknown> = {};
    Object.defineProperty(evidenceWithThrowingGetter, "value", {
      enumerable: true,
      get: (): never => {
        throw new Error("hostile evidence getter");
      }
    });
    await expectStoreError(
      store.writeEvidence(
        "generation-1",
        "evidence/hostile.json",
        evidenceWithThrowingGetter
      ),
      "INVALID_EVIDENCE"
    );

    expectSynchronousStoreError(
      () => new FileSystemGenerationSessionStore(hostile as string),
      "IO_ERROR"
    );
    expectSynchronousStoreError(
      () => new FileSystemGenerationSessionStore(
        root,
        hostile
      ),
      "IO_ERROR"
    );
  });

  it("rejects evidence paths whose existing parent is a symbolic link", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const workDirectory = join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work"
    );
    await import("node:fs/promises").then(async ({ symlink }) => {
      await symlink(outside, join(workDirectory, "linked"));
    });

    await expectStoreError(
      store.writeEvidence("generation-1", "linked/outside.json", {}),
      "INVALID_EVIDENCE_PATH"
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("types only a genuinely absent evidence file as not found", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(
      store.readEvidence("generation-1", "verification/receipt.json"),
      "EVIDENCE_NOT_FOUND"
    );
  });

  it("does not type a substituted evidence parent as not found", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const workDirectory = join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work"
    );
    await import("node:fs/promises").then(async ({ symlink }) => {
      await symlink(outside, join(workDirectory, "verification"));
    });

    await expectStoreError(
      store.readEvidence("generation-1", "verification/receipt.json"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("publishes only a completed, successfully published session", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = verificationCandidate();
    await store.create(initial);

    await expectStoreError(
      store.publish("generation-1"),
      "SESSION_NOT_PUBLISHABLE"
    );
    const running = await store.beginVerification(
      "generation-1",
      0,
      "verification-attempt"
    );
    const passed = {
      ...running,
      revision: 2,
      verification: {
        status: "passed" as const,
        attemptId: "verification-attempt",
        reportPath: "verification/report.json",
        reportSha256: "f".repeat(64),
        runId: "verification-run"
      }
    };
    await store.completeVerification("generation-1", 1, passed);
    await expectStoreError(
      store.publish("generation-1"),
      "SESSION_NOT_PUBLISHABLE"
    );
  });

  it("atomically renames a publishable work bundle to its final directory", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = verificationCandidate();
    await store.create(initial);
    await store.writeEvidence("generation-1", "evidence/result.json", {
      accepted: true
    });
    const completed = await markPublishable(store, initial);

    const published = await store.publish("generation-1");

    expect(published).toBe(join(
      root,
      ".taphound",
      "build",
      "generations",
      "generation-1"
    ));
    await expect(readdir(join(
      root,
      ".taphound",
      "build",
      "generations"
    ))).resolves.toEqual([".locks", "generation-1"]);
    await expect(readFile(join(
      published,
      "evidence",
      "result.json"
    ), "utf8")).resolves.toContain('"accepted": true');
    await expect(store.read("generation-1")).resolves.toEqual(completed);
  });

  it("freezes state and evidence after a bundle is marked publishable", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const initial = verificationCandidate();
    await store.create(initial);
    const completed = await markPublishable(store, initial);

    await expectStoreError(
      store.writeEvidence("generation-1", "late.json", {}),
      "SESSION_PUBLISHED"
    );
    await expectStoreError(store.commitSnapshot(
      "generation-1",
      completed.revision,
      {
        ...completed,
        revision: completed.revision + 1,
        bindings: {
          ...completed.bindings,
          snapshotHash: "9".repeat(64)
        }
      }
    ), "INVALID_TRANSITION");
    await expect(store.read("generation-1")).resolves.toEqual(completed);
  });

  it("rejects active-bundle substitution before publish rename", async () => {
    const root = await temporaryRoot();
    let substituteBundle = false;
    const active = activeDirectory(root);
    const movedActive = `${active}.moved`;
    const publishable = validSession(0, {
      verification: {
        status: "passed",
        attemptId: "verification-attempt",
        reportPath: "verification/report.json",
        reportSha256: "f".repeat(64),
        runId: "verification-run"
      },
      publication: {
        status: "published",
        journeyPath: ".taphound/journeys/generated.json"
      }
    });
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforePublishRename: async (): Promise<void> => {
          if (substituteBundle) {
            substituteBundle = false;
            await rename(active, movedActive);
            await mkdir(active);
            await writeFile(
              join(active, "state.json"),
              `${JSON.stringify(publishable, null, 2)}\n`,
              "utf8"
            );
          }
        }
      }
    });
    await store.create(publishable);
    substituteBundle = true;

    await expectStoreError(store.publish("generation-1"), "IO_ERROR");
    await expect(stat(join(
      generationRoot(root),
      "generation-1"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a duplicate final destination", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const generationRoot = join(root, ".taphound", "build", "generations");
    const finalDirectory = join(generationRoot, "generation-1");
    await mkdir(finalDirectory);
    await writeFile(join(finalDirectory, "owner.txt"), "existing", "utf8");

    await expectStoreError(
      store.publish("generation-1"),
      "PUBLISH_DESTINATION_EXISTS"
    );
    await expect(readFile(join(finalDirectory, "owner.txt"), "utf8"))
      .resolves.toBe("existing");
    await expect(readFile(join(
      generationRoot,
      ".generation-1.work",
      "state.json"
    ), "utf8")).resolves.toContain('"revision": 0');
  });

  it("idempotently returns an already-published bundle", async () => {
    const root = await temporaryRoot();
    const synced: string[] = [];
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterDirectorySync: (path): void => {
          synced.push(path);
        }
      }
    });
    const initial = verificationCandidate();
    await store.create(initial);
    const completed = await markPublishable(store, initial);
    const first = await store.publish("generation-1");
    synced.length = 0;

    await expect(store.publish("generation-1")).resolves.toBe(first);
    expect(synced).toContain(generationRoot(root));
    await expect(store.read("generation-1")).resolves.toEqual(completed);
  });

  it("locks reads so publish never exposes a transient not-found state", async () => {
    const root = await temporaryRoot();
    let racingRead: Promise<GenerationSession> | undefined;
    const reader = new FileSystemGenerationSessionStore(root);
    const publisher = new FileSystemGenerationSessionStore(root, {
      hooks: {
        beforePublishRename: (): void => {
          racingRead = reader.read("generation-1");
        }
      }
    });
    const initial = verificationCandidate();
    await publisher.create(initial);
    const completed = await markPublishable(publisher, initial);

    await publisher.publish("generation-1");

    expect(racingRead).toBeDefined();
    await expect(racingRead).resolves.toEqual(completed);
  });

  it("parses persisted state through GenerationSessionSchema", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const statePath = join(
      root,
      ".taphound",
      "build",
      "generations",
      ".generation-1.work",
      "state.json"
    );
    const malformedPath = `${statePath}.malformed`;
    await writeFile(malformedPath, JSON.stringify({
      ...validSession(),
      unknown: true
    }), "utf8");
    await rename(malformedPath, statePath);

    await expectStoreError(store.read("generation-1"), "INVALID_SESSION");
    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "INVALID_SESSION"
    );

    await writeFile(statePath, JSON.stringify({
      ...validSession(),
      id: "../persisted-escape"
    }), "utf8");
    await expectStoreError(store.read("generation-1"), "INVALID_SESSION");
  });

  it("rejects persisted state moved under a different session id", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const generationRoot = join(root, ".taphound", "build", "generations");
    await rename(
      join(generationRoot, ".generation-1.work"),
      join(generationRoot, ".different-generation.work")
    );

    await expectStoreError(
      store.read("different-generation"),
      "INVALID_SESSION"
    );
  });

  it("lists immutable evidence deterministically without internal files", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await store.writeTextEvidence("generation-1", "z-last.txt", "last");
    await store.writeEvidence("generation-1", "evidence/a.json", { a: 1 });
    await store.writeTextEvidence("generation-1", "manifest.json", "self");

    await expect(store.listEvidence("generation-1")).resolves.toEqual([
      {
        path: "evidence/a.json",
        contentBase64: Buffer.from('{\n  "a": 1\n}\n').toString("base64"),
        byteLength: 13
      },
      {
        path: "z-last.txt",
        contentBase64: Buffer.from("last").toString("base64"),
        byteLength: 4
      }
    ]);
  });

  it("rejects symlinks while listing evidence", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await writeFile(join(root, "outside.txt"), "outside", "utf8");
    await symlink(
      join(root, "outside.txt"),
      join(activeDirectory(root), "linked.txt")
    );

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects evidence substitution after no-follow open while listing", async () => {
    const root = await temporaryRoot();
    let substitute = false;
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterEvidenceRead: async (path): Promise<void> => {
          if (substitute && path === "evidence.json") {
            substitute = false;
            const evidencePath = join(activeDirectory(root), path);
            await rename(evidencePath, `${evidencePath}.moved`);
            await writeFile(evidencePath, "replacement", "utf8");
          }
        }
      }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    substitute = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects same-inode evidence mutation during snapshot read", async () => {
    const root = await temporaryRoot();
    let mutate = false;
    const evidencePath = join(activeDirectory(root), "evidence.json");
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: {
        afterEvidenceOpen: async (path): Promise<void> => {
          if (mutate && path === "evidence.json") {
            mutate = false;
            await writeFile(evidencePath, "x".repeat(17), "utf8");
          }
        }
      }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    mutate = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects a sibling added after the first evidence directory read", async () => {
    const root = await temporaryRoot();
    let addSibling = false;
    const hook = async (path: string, phase: string): Promise<void> => {
      if (addSibling && path === "" && phase === "beforeTraversal") {
        addSibling = false;
        await writeFile(
          join(activeDirectory(root), "unlisted.json"),
          "{}\n",
          "utf8"
        );
      }
    };
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: { afterEvidenceDirectoryRead: hook }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    addSibling = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects a sibling removed after the first evidence directory read", async () => {
    const root = await temporaryRoot();
    let removeSibling = false;
    const hook = async (path: string, phase: string): Promise<void> => {
      if (removeSibling && path === "" && phase === "beforeTraversal") {
        removeSibling = false;
        await unlink(join(activeDirectory(root), "removed.json"));
      }
    };
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: { afterEvidenceDirectoryRead: hook }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    await store.writeEvidence("generation-1", "removed.json", { ok: true });
    removeSibling = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects an entry type swap after the first directory read", async () => {
    const root = await temporaryRoot();
    let swapType = false;
    const hook = async (path: string, phase: string): Promise<void> => {
      if (swapType && path === "" && phase === "beforeTraversal") {
        swapType = false;
        const evidencePath = join(activeDirectory(root), "evidence.json");
        await unlink(evidencePath);
        await mkdir(evidencePath);
      }
    };
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: { afterEvidenceDirectoryRead: hook }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    swapType = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });

  it("rejects directory metadata churn even when names remain identical", async () => {
    const root = await temporaryRoot();
    let churnDirectory = false;
    const hook = async (path: string, phase: string): Promise<void> => {
      if (churnDirectory && path === "" && phase === "afterTraversal") {
        churnDirectory = false;
        const temporaryPath = join(activeDirectory(root), "transient");
        await writeFile(temporaryPath, "temporary", "utf8");
        await unlink(temporaryPath);
      }
    };
    const store = new FileSystemGenerationSessionStore(root, {
      hooks: { afterEvidenceDirectoryRead: hook }
    });
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence.json", { ok: true });
    churnDirectory = true;

    await expectStoreError(
      store.listEvidence("generation-1"),
      "INVALID_EVIDENCE_PATH"
    );
  });
});
