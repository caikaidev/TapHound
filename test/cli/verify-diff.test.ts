import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { ImpactSet } from "../../src/domain/impact.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const emptyImpact: ImpactSet = {
  version: 1,
  base: "origin/main",
  head: "HEAD",
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

interface DiffDependencies extends CliDependencies {
  impact: NonNullable<CliDependencies["impact"]>;
  gitDiff: NonNullable<CliDependencies["gitDiff"]>;
}

function baseDependencies(exitCodes: number[]): DiffDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.3.0" },
          { name: "adb" as const, status: "passed" as const, version: "1.0.41" }
        ]
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    impact: {
      resolve: vi.fn(() => Promise.resolve(emptyImpact))
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
    projectDescriber: { describe: vi.fn() },
    contextValidator: { validate: vi.fn() },
    contextLoader: { load: vi.fn(), readIndex: vi.fn() },
    contextRefresher: { refresh: vi.fn() },
    contextGenerator: { generate: vi.fn() },
    contextRehasher: { rehash: vi.fn() },
    init: { install: vi.fn() },
    initPrompt: { selectAgents: vi.fn() },
    align: { alignCamera: vi.fn() },
    observer: (): { observe: () => Promise<never> } => ({ observe: vi.fn() }),
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
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

interface DiffVerdictPayload {
  overall: string;
  note?: string;
  results: { name: string; selection: string; status: string }[];
}

function parseVerdict(output: BufferOutput): DiffVerdictPayload {
  return JSON.parse(output.value) as DiffVerdictPayload;
}

describe("verify --diff", () => {
  it("routes to diff verification and emits no-change pass", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    vi.mocked(dependencies.gitDiff.diff).mockResolvedValue({
      version: 1,
      base: "origin/main",
      head: "HEAD",
      files: []
    });
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--diff", "origin/main",
      "--project", "/project",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = parseVerdict(dependencies.stdout as BufferOutput);
    expect(output.overall).toBe("passed");
    expect(output.note).toBe("No changes; nothing to verify");
    expect(output.results).toEqual([]);
    const impact = dependencies.impact;
    expect(vi.mocked(impact.resolve)).toHaveBeenCalledWith({
      projectRoot: "/project",
      packageName: "com.example.app",
      changeSet: {
        version: 1,
        base: "origin/main",
        head: "HEAD",
        files: []
      }
    });
  });

  it("accepts custom base via --base and scope via --scope", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--diff", "v1.0",
      "--base", "v0.9",
      "--scope", "p0",
      "--project", "/project",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    expect(vi.mocked(dependencies.gitDiff.diff)).toHaveBeenCalledWith({
      projectRoot: "/project",
      base: "v0.9",
      head: "HEAD"
    });
  });

  it("uses --diff ref as the default base", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--diff", "v1.0",
      "--project", "/project",
      "--json"
    ]);
    expect(vi.mocked(dependencies.gitDiff.diff)).toHaveBeenCalledWith({
      projectRoot: "/project",
      base: "v1.0",
      head: "HEAD"
    });
  });

  it("is exclusive with --journey and --contract", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--diff", "main",
      "--journey", ".taphound/journeys/search.json",
      "--project", "/project",
      "--json"
    ]);
    // --diff wins (documented first-match); diff path runs with no journeys selected
    expect(exitCodes[0]).toBe(0);
  });
});