import { vi } from "vitest";

import type {
  LocalTargets
} from "../../src/cli/dependencies.js";
import type {
  LocalTargetService
} from "../../src/application/target/local-target-service.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";

export function defaultLocalTargets(): LocalTargets {
  const resolver = {
    resolve: vi.fn(),
    resolveByPath: vi.fn(),
    fingerprint: vi.fn()
  } as unknown as TargetResolver;
  const service = {} as unknown as LocalTargetService;
  return {
    targetsHome: () => "/targets",
    configStore: {
      loadTargets: vi.fn(() => Promise.resolve({
        targets: {},
        official: undefined,
        local: undefined
      })),
      appendLocalTarget: vi.fn(() => Promise.resolve(undefined)),
      removeLocalTarget: vi.fn(() => Promise.resolve(false))
    },
    pathResolver: { resolve: vi.fn() },
    workspace: {
      root: () => "/targets/.taphound/local",
      identityPath: () => "/targets/.taphound/local/identity.json",
      readIdentity: vi.fn(() => Promise.resolve(null)),
      writeIdentity: vi.fn(() => Promise.resolve(undefined)),
      ensureWorkspace: vi.fn(() => Promise.resolve(undefined)),
      ensureTaphoundIgnored: vi.fn(() => Promise.resolve(undefined))
    },
    targetResolver: () => resolver,
    localTargetService: () => service,
    localSync: {
      sync: vi.fn((input: { targetId: string; projectRoot: string; targetsHome: string }) => Promise.resolve({
        targetId: input.targetId,
        projectRoot: input.projectRoot,
        workspaceRoot: "/targets/.taphound/local/" + input.targetId,
        syncedDirs: [],
        filesCopied: 0,
        skippedBuild: true
      }))
    },
    processRunner: {
      run: vi.fn(() => Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        cancelled: false
      })),
      start: vi.fn()
    },
    clock: { now: () => new Date() }
  };
}