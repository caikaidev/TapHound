import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  readGenerationContextSnapshot
} from "../../../src/application/generation/generation-context-snapshot.js";
import {
  GenerationOperationError,
  hashGenerationBinding
} from "../../../src/application/generation/generation-starter.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import { GENERATION_CONTEXT_SNAPSHOT_PATH } from "../../../src/domain/workspace.js";
import {
  GenerationSessionStoreError
} from "../../../src/ports/generation-session-store.js";
import { resolvedProjectContext } from "../../fixtures/project-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

function session(contextHash: string): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision: 0,
    state: "active",
    bindings: {
      projectHash: "0".repeat(64),
      configHash: "1".repeat(64),
      contextHash,
      snapshotHash: null
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: resolvedProjectContext.interactionPolicy
    },
    contextSelection: resolvedProjectContext.selection,
    variables: {
      runId: "candidate-run",
      timestamp: "2026-07-23T00:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    externalFlows: []
  };
}

async function store(): Promise<{
  root: string;
  store: FileSystemGenerationSessionStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-snapshot-"));
  roots.push(root);
  return { root, store: new FileSystemGenerationSessionStore(root) };
}

describe("readGenerationContextSnapshot", () => {
  it("returns null for legacy sessions without stored snapshot evidence", async () => {
    const test = await store();
    await test.store.create(
      session(hashGenerationBinding(resolvedProjectContext))
    );

    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).resolves.toBeNull();
  });

  it("round-trips the persisted session context snapshot", async () => {
    const test = await store();
    await test.store.create(
      session(hashGenerationBinding(resolvedProjectContext))
    );
    await test.store.writeEvidence(
      "generation-1",
      GENERATION_CONTEXT_SNAPSHOT_PATH,
      resolvedProjectContext
    );

    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).resolves.toEqual(resolvedProjectContext);
  });

  it("rejects an unreadable snapshot", async () => {
    const test = await store();
    await test.store.create(
      session(hashGenerationBinding(resolvedProjectContext))
    );
    await test.store.writeEvidence(
      "generation-1",
      GENERATION_CONTEXT_SNAPSHOT_PATH,
      "not a resolved context"
    );

    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).rejects.toMatchObject({
      code: "CONTEXT_INVALID"
    });
  });

  it("rejects a tampered snapshot that no longer matches the binding", async () => {
    const test = await store();
    await test.store.create(
      session(hashGenerationBinding(resolvedProjectContext))
    );
    await test.store.writeEvidence(
      "generation-1",
      GENERATION_CONTEXT_SNAPSHOT_PATH,
      {
        ...resolvedProjectContext,
        packageName: "com.example.attacker"
      }
    );

    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).rejects.toBeInstanceOf(GenerationOperationError);
    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).rejects.toMatchObject({
      code: "CONTEXT_INVALID",
      message: "Stored context snapshot does not match the session context binding"
    });
  });

  it("propagates store errors for missing sessions", async () => {
    const test = await store();

    await expect(
      readGenerationContextSnapshot({ store: test.store }, "generation-1")
    ).rejects.toBeInstanceOf(GenerationSessionStoreError);
  });
});
