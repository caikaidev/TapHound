import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";
import type { LocalTargetService } from "../../src/application/target/local-target-service.js";
import type { ImpactSet } from "../../src/domain/impact.js";
import { TargetError, type TargetEntry } from "../../src/domain/target.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
import { validReport } from "../fixtures/report.js";

type ImpactDependencies = CliDependencies & {
  gitDiff: NonNullable<CliDependencies["gitDiff"]>;
  impact: NonNullable<CliDependencies["impact"]>;
  journeyCompositionStore: NonNullable<
    CliDependencies["journeyCompositionStore"]
  >;
};

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

function emptyImpact(base: string, head: string): ImpactSet {
  return {
    version: 1,
    base,
    head,
    affectedModules: [],
    affectedFeatures: [],
    affectedScreens: [],
    affectedAnchors: [],
    affectedTransitions: [],
    selectedJourneys: { p0: [], p1: [], p2: [] },
    skippedJourneys: [],
    provenance: {
      contextHash: "a".repeat(64),
      knowledgeHash: "b".repeat(64)
    }
  };
}

function baseDependencies(exitCodes: number[]): ImpactDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.3.0" },
          { name: "adb" as const, status: "passed" as const, version: "1.0.41" },
          { name: "android" as const, status: "passed" as const, version: "0.1.0" }
        ]
      }))
    },
    recorder: { record: vi.fn() },
    verifier: {
      verify: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        exitCode: 0 as const,
        report: validReport(),
        reportPath: "/reports/report.json",
        summaryPath: "/reports/summary.txt"
      }))
    },
    projectDescriber: {
      describe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextValidator: {
      validate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextLoader: {
      load: vi.fn(() => Promise.reject(new Error("unused"))),
      readIndex: vi.fn(() => Promise.reject(new Error("unused")))
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
    init: {
      install: vi.fn(() => Promise.reject(new Error("unused")))
    },
    initPrompt: {
      selectAgents: vi.fn(() => Promise.reject(new Error("unused")))
    },
    align: {
      alignCamera: vi.fn(() => Promise.reject(new Error("unused")))
    },
    observer: () => ({
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    }),
    generationStarter: {
      start: vi.fn(() => Promise.reject(new Error("unused")))
    },
    runtimeObserver: {
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    workspaceLayout: fakeWorkspaceLayout(),
    localTargets: defaultLocalTargets(),
    journeyCompositionStore: {
      writeText: vi.fn(),
      read: vi.fn(() => Promise.resolve(Buffer.from(
        JSON.stringify({
          version: 2,
          name: "search",
          devices: [{ role: "default" }],
          steps: [{
            action: "wait",
            activity: {
              before: "com.example.app.MainActivity",
              after: "com.example.app.MainActivity"
            }
          }]
        })
      ))),
      listJourneyPaths: vi.fn(() => Promise.resolve([])),
      readJourneyMeta: vi.fn(() => Promise.resolve(null))
    },
    impact: {
      resolve: vi.fn(() => Promise.resolve(emptyImpact("origin/main", "HEAD")))
    },
    gitDiff: {
      diff: vi.fn(() => Promise.resolve({
        version: 1 as const,
        base: "origin/main",
        head: "HEAD",
        files: [{
          path: "app/src/main/res/layout/activity_main.xml",
          status: "modified" as const
        }]
      }))
    },
    readJson: vi.fn(() => Promise.resolve({
      version: 1,
      run: { packageName: "com.example.app", activity: ".MainActivity" },
      idle: { pollIntervalMs: 200, stablePolls: 2, timeoutMs: 5000 },
      artifactsDir: "reports"
    })),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

const TARGET_WORKSPACE = "/targets/.taphound/local/app";

function targetDependencies(exitCodes: number[]): ImpactDependencies {
  const dependencies = baseDependencies(exitCodes);
  dependencies.localTargets.targetResolver = (): TargetResolver => ({
    resolve: vi.fn(() => Promise.resolve({
      id: "app",
      sourceType: "local" as const,
      configuredPath: "/real/app",
      resolvedPath: "/real/app",
      project: {
        rootDir: "/real/app",
        settingsFile: "settings.gradle.kts",
        gitRoot: "/real/repo"
      },
      workspaceRoot: TARGET_WORKSPACE
    })),
    resolveByPath: vi.fn(),
    fingerprint: vi.fn(() => Promise.resolve({
      schemaVersion: 1 as const,
      hash: "a".repeat(64)
    }))
  } as unknown as TargetResolver);
  dependencies.localTargets.configStore = {
    ...dependencies.localTargets.configStore,
    loadTargets: vi.fn(() => Promise.resolve({
      targets: {
        app: {
          id: "app",
          source: { type: "local" as const, path: "/real/app" },
          run: {
            packageName: "com.example.app",
            activity: ".MainActivity"
          },
          git: { enabled: true },
          override: false
        }
      },
      official: undefined,
      local: undefined
    }))
  };
  dependencies.localTargets.localTargetService = (): LocalTargetService => ({
    configForTarget: (input: {
      entry: TargetEntry;
      resolvedPath: string;
      workspaceRoot: string;
    }) => ({
      version: 1,
      run: {
        packageName: input.entry.run.packageName,
        activity: input.entry.run.activity
      },
      idle: {
        strategy: "hybrid",
        pollIntervalMs: 200,
        stablePolls: 2,
        timeoutMs: 5000
      },
      artifactsDir: `${input.workspaceRoot}/runs`
    }),
    assertProjectUnchanged: vi.fn(() => Promise.resolve(undefined))
  } as unknown as LocalTargetService);
  return dependencies;
}

async function runVerifyChanges(
  dependencies: ImpactDependencies,
  args: readonly string[]
): Promise<void> {
  await createProgram(dependencies).parseAsync([
    "node", "taphound", "verify-changes",
    ...args
  ]);
}

describe("verify-changes", () => {
  it("passes through with exit 0 when the change set selects no journeys", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    vi.mocked(dependencies.gitDiff.diff).mockResolvedValue({
      version: 1 as const,
      base: "origin/main",
      head: "WORKTREE",
      files: []
    });

    await runVerifyChanges(dependencies, [
      "--project", "/project",
      "--base", "origin/main",
      "--head", "WORKTREE",
      "--json"
    ]);

    const payload = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { overall: string; results: unknown[]; note?: string };
    expect(payload.results).toEqual([]);
    expect(payload.overall).toBe("passed");
    expect(payload.note).toBe("No changes; nothing to verify");
    expect(exitCodes).toEqual([0]);
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
  });

  it("--target resolves gitRoot for the diff and journeys from the workspace", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    vi.mocked(dependencies.impact.resolve).mockResolvedValue({
      ...emptyImpact("origin/main", "WORKTREE"),
      selectedJourneys: {
        p0: [{
          id: "journeys/search.json",
          reason: "journey resolves affected Knowledge anchor demo.search.open"
        }],
        p1: [],
        p2: []
      }
    });

    await runVerifyChanges(dependencies, [
      "--target", "app",
      "--base", "origin/main",
      "--json"
    ]);

    expect(dependencies.gitDiff.diff).toHaveBeenCalledWith({
      projectRoot: "/real/repo",
      base: "origin/main",
      head: "WORKTREE"
    });
    const resolveCall = vi.mocked(dependencies.impact.resolve).mock.calls[0]?.[0];
    expect(resolveCall).not.toBeUndefined();
    expect(resolveCall?.projectRoot).toBe("/real/app");
    expect(resolveCall?.workspaceRoot).toBe(TARGET_WORKSPACE);
    expect(dependencies.journeyCompositionStore.read).toHaveBeenCalledWith({
      projectRoot: "/real/app",
      relativePath: "journeys/search.json",
      workspaceRoot: TARGET_WORKSPACE
    });
    expect(dependencies.verifier.verify).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
    const payload = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { target: { id: string; resolvedPath: string } };
    expect(payload.target).toEqual({ id: "app", resolvedPath: "/real/app" });
  });

  it("--target uses exit 2 for an unknown id", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    dependencies.localTargets.targetResolver = (): TargetResolver => ({
      resolve: vi.fn(() => Promise.reject(new TargetError(
        "LOCAL_TARGET_NOT_FOUND",
        'Local target "missing" is not registered'
      ))),
      resolveByPath: vi.fn(),
      fingerprint: vi.fn()
    } as unknown as TargetResolver);

    await runVerifyChanges(dependencies, [
      "--target", "missing",
      "--json"
    ]);

    const payload = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(payload.exitCode).toBe(2);
    expect(payload.failure.code).toBe("LOCAL_TARGET_NOT_FOUND");
    expect(exitCodes).toEqual([2]);
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
  });

  it("--target maps GIT_REF_INVALID to exit 2", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    vi.mocked(dependencies.gitDiff.diff).mockRejectedValue({
      code: "GIT_REF_INVALID",
      message: "bad base ref"
    });

    await runVerifyChanges(dependencies, [
      "--target", "app",
      "--base", "does-not-exist",
      "--json"
    ]);

    const payload = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(payload.exitCode).toBe(2);
    expect(payload.failure.code).toBe("GIT_REF_INVALID");
    expect(exitCodes).toEqual([2]);
  });
});