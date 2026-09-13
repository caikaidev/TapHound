import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { TargetError } from "../../src/domain/target.js";
import type {
  CliDependencies,
  LocalTargets,
  TextOutput
} from "../../src/cli/dependencies.js";
import type { LocalTargetService } from "../../src/application/target/local-target-service.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";
import type { LoadedTargets } from "../../src/ports/target-config-store.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import {
  projectContextIndex,
  projectContextModule,
  resolvedProjectContext
} from "../fixtures/project-context.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const PROJECT_ROOT = "/real/app";
const WORKSPACE_ROOT = "/targets/.taphound/local/work-app";
const TARGET_ID = "work-app";

function makeLocalTargets(): {
  bundle: LocalTargets;
  resolve: ReturnType<typeof vi.fn>;
  loadTargets: ReturnType<typeof vi.fn>;
  configForTarget: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn(() => Promise.resolve({
    id: TARGET_ID,
    sourceType: "local" as const,
    configuredPath: PROJECT_ROOT,
    resolvedPath: PROJECT_ROOT,
    project: {
      rootDir: PROJECT_ROOT,
      settingsFile: "settings.gradle.kts",
      gitRoot: PROJECT_ROOT
    },
    workspaceRoot: WORKSPACE_ROOT
  }));
  const resolver = { resolve } as unknown as TargetResolver;
  const loadTargets = vi.fn<(targetsHome: string) => Promise<LoadedTargets>>(
    () => Promise.resolve({
      targets: {
        [TARGET_ID]: {
          id: TARGET_ID,
          source: { type: "local" as const, path: PROJECT_ROOT },
          run: { packageName: "com.example.app", activity: ".MainActivity" },
          git: { enabled: true },
          override: false
        }
      },
      official: undefined,
      local: undefined
    })
  );
  const configForTarget = vi.fn((input: {
    entry: { run: { packageName: string; activity?: string } };
    workspaceRoot: string;
  }) => (
    TapHoundConfigSchema.parse({
      version: 1,
      run: {
        packageName: input.entry.run.packageName,
        activity: input.entry.run.activity ?? ".MainActivity"
      },
      idle: {
        strategy: "hybrid",
        pollIntervalMs: 200,
        stablePolls: 2,
        timeoutMs: 5000
      },
      artifactsDir: `${input.workspaceRoot}/runs`
    })
  ));
  const service = {
    configForTarget,
    assertProjectUnchanged: vi.fn(() => Promise.resolve(undefined))
  };
  const bundle: LocalTargets = {
    targetsHome: () => "/targets",
    configStore: {
      loadTargets,
      appendLocalTarget: vi.fn(() => Promise.resolve(undefined)),
      removeLocalTarget: vi.fn(() => Promise.resolve(false))
    },
    pathResolver: { resolve: vi.fn() },
    workspace: {
      root: vi.fn(() => WORKSPACE_ROOT),
      identityPath: vi.fn(() => join(WORKSPACE_ROOT, "identity.json")),
      readIdentity: vi.fn(() => Promise.resolve(null)),
      writeIdentity: vi.fn(() => Promise.resolve(undefined)),
      ensureWorkspace: vi.fn(() => Promise.resolve(undefined)),
      ensureTaphoundIgnored: vi.fn(() => Promise.resolve(undefined))
    },
    targetResolver: () => resolver,
    localTargetService: () => (service as unknown as LocalTargetService),
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
    localSync: {
      sync: vi.fn((input: { targetId: string; projectRoot: string; targetsHome: string }): Promise<{ targetId: string; projectRoot: string; workspaceRoot: string; syncedDirs: string[]; filesCopied: number; skippedBuild: boolean }> => Promise.resolve({
        targetId: input.targetId,
        projectRoot: input.projectRoot,
        workspaceRoot: `/targets/.taphound/local/${input.targetId}`,
        syncedDirs: [],
        filesCopied: 0,
        skippedBuild: true
      })),
    },
    clock: { now: () => new Date() }
  };
  return { bundle, resolve, loadTargets, configForTarget };
}

function baseDependencies(
  exitCodes: number[],
  localTargets: LocalTargets
): CliDependencies {
  return {
    localTargets,
    doctor: {
      run: vi.fn(() => Promise.reject(new Error("unused")))
    },
    recorder: {
      record: vi.fn(() => Promise.reject(new Error("unused")))
    },
    verifier: {
      verify: vi.fn(() => Promise.reject(new Error("unused")))
    },
    projectDescriber: {
      describe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextValidator: {
      validate: vi.fn(() => Promise.resolve({ status: "valid" as const }))
    },
    contextLoader: {
      load: vi.fn(() => Promise.resolve({
        context: resolvedProjectContext,
        bundle: projectContextIndex,
        modules: [projectContextModule]
      })),
      readIndex: vi.fn(() => Promise.resolve({
        bundle: projectContextIndex,
        indexHash: "a".repeat(64)
      }))
    },
    contextRefresher: {
      refresh: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextGenerator: {
      generate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextRehasher: {
      rehash: vi.fn(() => Promise.reject(new Error("unused")))
    },
    generationStarter: {
      start: vi.fn(() => Promise.reject(new Error("unused")))
    },
    runtimeObserver: {
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    init: { install: vi.fn(() => Promise.reject(new Error("unused"))) },
    initPrompt: {
      selectAgents: vi.fn(() => Promise.reject(new Error("unused")))
    },
    align: { alignCamera: vi.fn(() => Promise.reject(new Error("unused"))) },
    observer: () => ({
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    }),
    workspaceLayout: fakeWorkspaceLayout(),
    readJson: vi.fn(() => Promise.resolve(undefined)),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

async function runContext(
  dependencies: CliDependencies,
  args: readonly string[]
): Promise<void> {
  await createProgram(dependencies).parseAsync(["node", "taphound", ...args]);
}

function jsonOutput(dependencies: CliDependencies): Record<string, unknown> {
  const stdout = (dependencies.stdout as BufferOutput).value;
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function contextPathResolved(workspaceRoot: string): string {
  return `${workspaceRoot}/.taphound/context/project-context.json`;
}

describe("taphound context --target", () => {
  it("generate --target passes one JSON value and roots the context at the workspace root", async () => {
    const fake = makeLocalTargets();
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);
    vi.mocked(dependencies.contextGenerator.generate).mockResolvedValueOnce({
      status: "generated",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity",
      modules: [],
      indexHash: "b".repeat(64),
      contextPath: ".taphound/context/project-context.json"
    });

    await runContext(dependencies, [
      "context", "generate", "--target", TARGET_ID, "--json"
    ]);

    expect(exitCodes).toEqual([0]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({ status: "generated", exitCode: 0 });
    expect(dependencies.contextGenerator.generate).toHaveBeenCalledWith({
      projectRoot: PROJECT_ROOT,
      contextRoot: WORKSPACE_ROOT,
      contextPath: contextPathResolved(WORKSPACE_ROOT)
    });
  });

  it("status --target loads context from the workspace root", async () => {
    const fake = makeLocalTargets();
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);
    vi.mocked(dependencies.contextValidator.validate).mockResolvedValueOnce(
      { status: "valid" as const }
    );
    vi.mocked(dependencies.contextLoader.load).mockReturnValueOnce(
      Promise.resolve({
        context: resolvedProjectContext,
        bundle: projectContextIndex,
        modules: [projectContextModule]
      })
    );

    await runContext(dependencies, [
      "context", "status", "--target", TARGET_ID, "--json"
    ]);

    expect(exitCodes).toEqual([0]);
    expect(dependencies.contextLoader.load).toHaveBeenCalledWith({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: WORKSPACE_ROOT,
      contextPath: contextPathResolved(WORKSPACE_ROOT),
      allowIncomplete: true
    });
  });

  it("status --target threads identityPolicy configured and carries divergence in JSON", async () => {
    const fake = makeLocalTargets();
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);
    vi.mocked(dependencies.contextValidator.validate).mockResolvedValueOnce({
      status: "valid" as const,
      divergence: {
        evidencePackageName: "com.example.im",
        configuredPackageName: "com.example.tchat",
        launchActivity: "com.example.im.ui.SplashActivity"
      }
    });

    await runContext(dependencies, [
      "context", "status", "--target", TARGET_ID, "--json"
    ]);

    expect(exitCodes).toEqual([0]);
    expect(dependencies.contextValidator.validate).toHaveBeenCalledWith(
      expect.objectContaining({ identityPolicy: "configured" })
    );
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "valid",
      divergence: {
        evidencePackageName: "com.example.im",
        configuredPackageName: "com.example.tchat",
        launchActivity: "com.example.im.ui.SplashActivity"
      },
      exitCode: 0
    });
  });

  it("exits 2 with LOCAL_TARGET_NOT_FOUND for an unregistered target id", async () => {
    const fake = makeLocalTargets();
    vi.mocked(fake.resolve).mockRejectedValue(
      new TargetError("LOCAL_TARGET_NOT_FOUND", "not registered")
    );
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, fake.bundle);

    await runContext(dependencies, [
      "context", "generate", "--target", "nope", "--json"
    ]);

    expect(exitCodes).toEqual([2]);
    const output = jsonOutput(dependencies);
    expect(output).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "LOCAL_TARGET_NOT_FOUND" }
    });
  });
});