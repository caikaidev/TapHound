import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemGenerationSessionStore
} from "../../../src/adapters/filesystem/generation-session-store.js";
import {
  GenerationConfigService
} from "../../../src/application/generation/generation-config-service.js";
import {
  GenerationOperationError
} from "../../../src/application/generation/generation-starter.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import { resolvedProjectContext } from "../../fixtures/project-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

const config: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 500,
    stablePolls: 3,
    timeoutMs: 10000
  },
  artifactsDir: ".taphound/build/runs"
};

function session(overrides?: {
  state?: GenerationSession["state"];
  inFlight?: GenerationSession["inFlight"];
  pendingConfirmation?: GenerationSession["pendingConfirmation"];
  verification?: GenerationSession["verification"];
  idlePolicy?: GenerationSession["idlePolicy"];
}): GenerationSession {
  return {
    version: 1,
    id: "generation-1",
    revision: 0,
    state: overrides?.state ?? "active",
    bindings: {
      projectHash: "0".repeat(64),
      configHash: "1".repeat(64),
      contextHash: "2".repeat(64),
      snapshotHash: null
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: resolvedProjectContext.interactionPolicy
    },
    contextSelection: resolvedProjectContext.selection,
    ...(overrides?.idlePolicy === undefined
      ? {}
      : { idlePolicy: overrides.idlePolicy }),
    variables: {
      runId: "candidate-run",
      timestamp: "2026-07-23T00:00:00.000Z",
      randomHex: "c0ffee"
    },
    candidateSteps: [],
    candidateSources: [],
    inFlight: overrides?.inFlight ?? null,
    pendingConfirmation: overrides?.pendingConfirmation ?? null,
    verification: overrides?.verification ?? { status: "notRun" },
    publication: { status: "notRun" },
    externalFlows: []
  };
}

async function setup(overrides?: Parameters<typeof session>[0]): Promise<{
  store: FileSystemGenerationSessionStore;
  service: GenerationConfigService;
}> {
  const root = await mkdtemp(join(tmpdir(), "taphound-config-service-"));
  roots.push(root);
  const store = new FileSystemGenerationSessionStore(root);
  await store.create(session(overrides));
  return { store, service: new GenerationConfigService({ store }) };
}

describe("GenerationConfigService.updateIdlePolicy", () => {
  it("merges a patch onto the config idle base and bumps the revision", async () => {
    const test = await setup();

    const updated = await test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: { timeoutMs: 30000 }
    });

    expect(updated.revision).toBe(1);
    expect(updated.idlePolicy).toEqual({
      strategy: "hybrid",
      pollIntervalMs: 500,
      stablePolls: 3,
      timeoutMs: 30000
    });
    expect((await test.store.read("generation-1")).idlePolicy).toEqual({
      strategy: "hybrid",
      pollIntervalMs: 500,
      stablePolls: 3,
      timeoutMs: 30000
    });
  });

  it("builds subsequent patches on the stored session override", async () => {
    const test = await setup({
      idlePolicy: {
        strategy: "layoutDiff",
        pollIntervalMs: 250,
        stablePolls: 2,
        timeoutMs: 20000
      }
    });

    const updated = await test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: { stablePolls: 5 }
    });

    expect(updated.idlePolicy).toEqual({
      strategy: "layoutDiff",
      pollIntervalMs: 250,
      stablePolls: 5,
      timeoutMs: 20000
    });
  });

  it("rejects an empty patch", async () => {
    const test = await setup();

    await expect(test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: {}
    })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: /at least one setting/i
    });
  });

  it("rejects invalid idle values", async () => {
    const test = await setup();

    await expect(test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: { timeoutMs: -1 }
    })).rejects.toThrow();
  });

  it.each([
    ["in-flight step", { inFlight: { stepIndex: 0, snapshotHash: "a".repeat(64), proposalHash: "b".repeat(64), attemptId: "attempt-1" } }],
    ["running verification", {
      verification: {
        status: "running" as const,
        attemptId: "attempt-1",
        ownerPid: 42,
        startedAt: "2026-07-23T00:00:00.000Z"
      }
    }]
  ])("rejects updates while a %s exists", async (_label, overrides) => {
    const test = await setup(overrides);

    await expect(test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: { timeoutMs: 30000 }
    })).rejects.toBeInstanceOf(GenerationOperationError);
  });

  it("rejects updates on non-active sessions", async () => {
    const test = await setup({ state: "archived" });

    await expect(test.service.updateIdlePolicy({
      generationId: "generation-1",
      config,
      patch: { timeoutMs: 30000 }
    })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: /active session/
    });
  });
});
