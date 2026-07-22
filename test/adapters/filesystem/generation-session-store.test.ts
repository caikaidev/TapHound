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
  return join(root, ".taphound", "generations");
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
  const directory = lockDirectory(root);
  await mkdir(join(generationRoot(root), ".locks"), { recursive: true });
  await mkdir(directory);
  await writeFile(
    join(directory, "owner.json"),
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
      contextHash: "a".repeat(64),
      snapshotHash: "b".repeat(64)
    },
    variables: {
      runId: "journey-run-42",
      timestamp: "2026-07-22T12:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [{
      action: "wait",
      activity: { before: "com.example.app.MainActivity" }
    }],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    ...overrides
  };
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
      "generations",
      ".generation-1.work",
      "state.json"
    ), "utf8")).resolves.toBe(`${JSON.stringify(session, null, 2)}\n`);
  });

  it("rejects duplicate active and published session creation", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(
      store.create(validSession()),
      "SESSION_ALREADY_EXISTS"
    );

    await store.update(
      "generation-1",
      0,
      validSession(1, {
        verification: { status: "passed" },
        publication: {
          status: "published",
          journeyPath: "journeys/generated.json"
        }
      })
    );
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
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
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

  it("requires an explicit recovery transition for persisted inFlight state", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    const inFlight = validSession(0, {
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
    });

    await store.create(inFlight);

    await expect(store.read("generation-1")).resolves.toEqual(inFlight);
    await expectStoreError(
      store.update("generation-1", 0, validSession(1)),
      "INVALID_TRANSITION"
    );
    await expectStoreError(
      store.update("generation-1", 0, validSession(1, {
        inFlight: { stepIndex: 0, snapshotHash: "c".repeat(64) }
      })),
      "INVALID_TRANSITION"
    );

    const recoveryRequired = validSession(1, {
      state: "recoveryRequired",
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
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

  it("rejects recovery unless only recovery state and inFlight are cleared", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await expectStoreError(
      store.recover("generation-1", 0, validSession(1)),
      "INVALID_TRANSITION"
    );

    await store.update("generation-1", 0, validSession(1, {
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
    }));
    await store.update("generation-1", 1, validSession(2, {
      state: "recoveryRequired",
      inFlight: { stepIndex: 0, snapshotHash: "b".repeat(64) }
    }));
    await expectStoreError(
      store.recover("generation-1", 2, validSession(3, {
        candidateSteps: [{
          action: "back",
          activity: { before: "com.example.app.MainActivity" }
        }]
      })),
      "INVALID_TRANSITION"
    );
  });

  it("allows only one concurrent writer for the same revision", async () => {
    const root = await temporaryRoot();
    const firstStore = new FileSystemGenerationSessionStore(root);
    const secondStore = new FileSystemGenerationSessionStore(root);
    await firstStore.create(validSession());

    const results = await Promise.allSettled([
      firstStore.update("generation-1", 0, validSession(1, {
        pendingConfirmation: { stepIndex: 0, reason: "Confirm one" }
      })),
      secondStore.update("generation-1", 0, validSession(1, {
        pendingConfirmation: { stepIndex: 0, reason: "Confirm two" }
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

  it("ignores an interrupted temporary state file", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const workDirectory = join(
      root,
      ".taphound",
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
      lockDirectory(root),
      "owner.json"
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
      join(lockDirectory(root), "owner.json"),
      "utf8"
    )).resolves.toContain("replacement-owner");
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

  it("rejects evidence paths whose existing parent is a symbolic link", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const workDirectory = join(
      root,
      ".taphound",
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

  it("publishes only a completed, successfully published session", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());

    await expectStoreError(
      store.publish("generation-1"),
      "SESSION_NOT_PUBLISHABLE"
    );
    await store.update("generation-1", 0, validSession(1, {
      verification: { status: "passed" },
      publication: { status: "notRun" }
    }));
    await expectStoreError(
      store.publish("generation-1"),
      "SESSION_NOT_PUBLISHABLE"
    );
  });

  it("atomically renames a publishable work bundle to its final directory", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    await store.writeEvidence("generation-1", "evidence/result.json", {
      accepted: true
    });
    const completed = validSession(1, {
      verification: { status: "passed" },
      publication: {
        status: "published",
        journeyPath: "journeys/generated.json"
      }
    });
    await store.update("generation-1", 0, completed);

    const published = await store.publish("generation-1");

    expect(published).toBe(join(
      root,
      ".taphound",
      "generations",
      "generation-1"
    ));
    await expect(readdir(join(
      root,
      ".taphound",
      "generations"
    ))).resolves.toEqual([".locks", "generation-1"]);
    await expect(readFile(join(
      published,
      "evidence",
      "result.json"
    ), "utf8")).resolves.toContain('"accepted": true');
    await expect(store.read("generation-1")).resolves.toEqual(completed);
  });

  it("does not overwrite a duplicate final destination", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemGenerationSessionStore(root);
    await store.create(validSession());
    const generationRoot = join(root, ".taphound", "generations");
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
    await store.create(validSession());
    const completed = validSession(1, {
      verification: { status: "passed" },
      publication: {
        status: "published",
        journeyPath: "journeys/generated.json"
      }
    });
    await store.update("generation-1", 0, completed);
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
    await publisher.create(validSession());
    const completed = validSession(1, {
      verification: { status: "passed" },
      publication: {
        status: "published",
        journeyPath: "journeys/generated.json"
      }
    });
    await publisher.update("generation-1", 0, completed);

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
    const generationRoot = join(root, ".taphound", "generations");
    await rename(
      join(generationRoot, ".generation-1.work"),
      join(generationRoot, ".different-generation.work")
    );

    await expectStoreError(
      store.read("different-generation"),
      "INVALID_SESSION"
    );
  });
});
