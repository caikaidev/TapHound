import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type {
  CliDependencies,
  TextOutput
} from "../../src/cli/dependencies.js";
import { TargetError } from "../../src/domain/target.js";
import { hashGenerationBinding } from "../../src/application/generation/generation-starter.js";
import type { TapHoundConfig } from "../../src/domain/config.js";
import { runtimeConfig } from "../fakes/runtime-fixture.js";
import {
  contextSelection,
  projectContextIndex,
  resolvedProjectContext
} from "../fixtures/project-context.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const resolvedTarget = {
  id: "work-app",
  sourceType: "local" as const,
  configuredPath: "${TAPHOUND_WORK_APP}",
  resolvedPath: "/real/app",
  project: {
    rootDir: "/real/app",
    settingsFile: "/real/app/settings.gradle.kts",
    gitRoot: "/real/app"
  },
  workspaceRoot: "/ws"
};

const targetEntry = {
  id: "work-app",
  override: false,
  source: { type: "local" as const, path: "${TAPHOUND_WORK_APP}" },
  run: { packageName: "com.example.app", activity: ".MainActivity" }
};

const metaProjectHash = hashGenerationBinding({
  projectRoot: "/real/app",
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity"
});
const metaConfigHash = hashGenerationBinding(configForTarget());

const metaJson = {
  version: 1,
  status: "verified",
  generationId: "generation-1",
  journeyPath: ".taphound/journeys/search.json",
  bindings: {
    projectHash: metaProjectHash,
    configHash: metaConfigHash,
    contextHash: "c".repeat(64)
  },
  contextSelection,
  verification: {
    reportPath: "verification/report.json",
    reportSha256: "d".repeat(64),
    runId: "verify-run",
    runs: 1
  },
  manualOverrideStepIndexes: []
};

const journeyJson = {
  version: 2,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

interface Harness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  readIndex: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  listJourneyPaths: ReturnType<typeof vi.fn>;
  readJourneyMeta: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  const read = vi.fn(() => Promise.resolve(
    Buffer.from(`${JSON.stringify(journeyJson)}\n`, "utf8")
  ));
  const listJourneyPaths = vi.fn(() => Promise.resolve([
    ".taphound/journeys/search.json"
  ]));
  const readJourneyMeta = vi.fn(() => Promise.resolve(
    Buffer.from(`${JSON.stringify(metaJson)}\n`, "utf8")
  ));
  const writeText = vi.fn(() => Promise.resolve());
  const readIndex = vi.fn(() => Promise.resolve({
    bundle: projectContextIndex,
    indexHash: contextSelection.indexHash
  }));
  const dependencies = {
    cwd: (): string => "/project",
    signal: undefined,
    readJson: vi.fn(() => Promise.resolve(runtimeConfig)),
    stdout,
    stderr,
    setExitCode: (code: number): void => {
      exitCodes.push(code);
    },
    projectDescriber: {
      describe: vi.fn(() => Promise.resolve({
        projectRoot: "/real/app",
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      }))
    },
    contextLoader: {
      load: vi.fn(() => Promise.resolve({
        context: resolvedProjectContext,
        modules: resolvedProjectContext.selection.modules
      })),
      readIndex
    },
    journeyResolver: { resolve: vi.fn(), resolveFlow: vi.fn(), listFlows: vi.fn() },
    journeyCompositionStore: {
      read,
      listJourneyPaths,
      readJourneyMeta,
      writeText,
      listFlowPaths: vi.fn(),
      readOutput: vi.fn()
    },
    localTargets: {
      targetsHome: (): string => "/base",
      configStore: {
        loadTargets: vi.fn(() => Promise.resolve({
          targets: { "work-app": targetEntry },
          official: undefined,
          local: undefined
        })),
        appendLocalTarget: vi.fn(),
        removeLocalTarget: vi.fn()
      },
      pathResolver: { resolve: vi.fn() },
      workspace: { root: vi.fn() },
      targetResolver: (_home: string): {
        resolve: typeof resolveTarget;
        fingerprint: typeof fingerprintTarget;
      } => {
        void _home;
        return { resolve: resolveTarget, fingerprint: fingerprintTarget };
      },
      localTargetService: (_home: string): {
        configForTarget: (input: {
          entry: typeof targetEntry;
          resolvedPath: string;
          workspaceRoot: string;
        }) => ReturnType<typeof configForTarget>;
        assertProjectUnchanged: typeof assertUnchanged;
      } => {
        void _home;
        return { configForTarget, assertProjectUnchanged: assertUnchanged };
      }
    }
  } as unknown as CliDependencies;
  return {
    dependencies,
    stdout,
    stderr,
    exitCodes,
    readIndex,
    read,
    listJourneyPaths,
    readJourneyMeta,
    writeText
  };
}

const resolveTarget = vi.fn(() => Promise.resolve(resolvedTarget));
const fingerprintTarget = vi.fn(() => Promise.resolve({ hash: "e".repeat(64) }));
const assertUnchanged = vi.fn(() => Promise.resolve());

function configForTarget(): TapHoundConfig {
  return {
    version: 1,
    run: {
      packageName: "com.example.app",
      activity: ".MainActivity"
    },
    idle: { strategy: "hybrid", pollIntervalMs: 200, stablePolls: 2, timeoutMs: 5000 },
    artifactsDir: "/ws/runs"
  };
}

async function run(test: Harness, args: readonly string[]): Promise<void> {
  await createProgram(test.dependencies).parseAsync(["node", "taphound", ...args]);
}

describe("journey lifecycle --target", () => {
  it("checks Journeys from the local workspace with lifecycle output", async () => {
    const test = harness();
    await run(test, [
      "journey", "check",
      "--target", "work-app",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([0]);
    const payload = JSON.parse(test.stdout.value) as {
      lifecycle: Record<string, number>;
      journeys: { lifecycle?: string }[];
    };
    expect(payload.lifecycle).toEqual({
      draft: 0,
      verified: 1,
      suspect: 0,
      stale: 0,
      retired: 0
    });
    expect(payload.journeys[0]?.lifecycle).toBe("verified");
    expect(test.readIndex).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/real/app",
      workspaceRoot: "/ws",
      contextPath: "/ws/context/project-context.json"
    }));
    expect(test.listJourneyPaths).toHaveBeenCalledWith("/real/app", "/ws");
  });

  it("retires a Journey with --target through the workspace store", async () => {
    const test = harness();
    await run(test, [
      "journey", "retire",
      "--target", "work-app",
      "--journey", ".taphound/journeys/search.json",
      "--reason", "superseded",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([0]);
    const payload = JSON.parse(test.stdout.value) as {
      status: string;
      retiredAt: string;
    };
    expect(payload.status).toBe("retired");
    const writeCall = test.writeText.mock.calls[0]?.[0] as {
      workspaceRoot: string;
      content: string;
    };
    expect(writeCall.workspaceRoot).toBe("/ws");
    expect(writeCall.content).toContain('"retired"');
  });

  it("fails with LOCAL_TARGET_NOT_FOUND for an unknown target", async () => {
    const test = harness();
    resolveTarget.mockRejectedValueOnce(
      new TargetError("LOCAL_TARGET_NOT_FOUND", "no such target")
    );
    await run(test, [
      "journey", "check",
      "--target", "nope",
      "--json"
    ]);
    expect(test.exitCodes).toEqual([2]);
    const payload = JSON.parse(test.stdout.value) as {
      failure: { code: string };
    };
    expect(payload.failure.code).toBe("LOCAL_TARGET_NOT_FOUND");
  });
});