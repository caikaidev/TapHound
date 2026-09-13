import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { LoadedKnowledgeBundle } from "../../src/ports/knowledge-registry.js";
import type { FeatureMapProjection } from "../../src/domain/feature-map.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const bundle: LoadedKnowledgeBundle = {
  index: {
    version: 1,
    packageName: "dev.taphound.demo",
    revision: 2,
    anchors: [{
      id: "demo.search.input",
      path: ".taphound/knowledge/anchors/demo.search.input.json",
      sha256: "3e19ef9dc5d355edaa9f7feab8d160bff02fa47b3e2e1edcddbd5652ce7b3880",
      status: "verified"
    }],
    screens: [{
      id: "demo.main.screen",
      path: ".taphound/knowledge/screens/demo.main.screen.json",
      sha256: "cd55a53ea6a4a9e6a0b79c2964128bb783efefbabf794661d2b2ecfe695a0bb8",
      status: "observed"
    }, {
      id: "demo.search.screen",
      path: ".taphound/knowledge/screens/demo.search.screen.json",
      sha256: "39d3f6c3216cb56bb7a0b08ce4a57c47d17604b251b9da37c754832b902d1f29",
      status: "observed"
    }],
    transitions: [{
      id: "demo.main.open_search",
      path: ".taphound/knowledge/transitions/demo.main.open_search.json",
      sha256: "50920e8895b74646d9b668972404fcbf1680b302a80fc4cad33b054f8d94ca3a",
      status: "observed"
    }]
  },
  indexSha256: "0".repeat(64),
  knowledgeHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  anchors: [{
    version: 1,
    id: "demo.search.input",
    status: "verified",
    roles: ["actionable"],
    identity: {
      kind: "element",
      locator: { resourceId: "search_input" }
    }
  }],
  screens: [{
    version: 1,
    id: "demo.main.screen",
    status: "observed",
    requiredAnchors: [],
    optionalAnchors: [],
    forbiddenAnchors: [],
    predicates: []
  }, {
    version: 1,
    id: "demo.search.screen",
    status: "observed",
    requiredAnchors: ["demo.search.input"],
    optionalAnchors: [],
    forbiddenAnchors: [],
    predicates: []
  }],
  transitions: [{
    version: 1,
    id: "demo.main.open_search",
    status: "observed",
    fromScreen: "demo.main.screen",
    toScreen: "demo.search.screen",
    semantic: "open-search",
    action: { action: "click", anchorId: "demo.search.input" },
    verification: { targetScreen: "demo.search.screen", timeoutMs: 2000 },
    observations: { attempts: 4, successes: 3, recoveryCost: 0.5 }
  }]
};

function baseDependencies(exitCodes: number[]): CliDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: []
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    knowledge: {
      load: vi.fn(() => Promise.resolve(bundle)),
      bootstrap: vi.fn(),
      promote: vi.fn(),
      evolve: vi.fn(),
      listReceipts: vi.fn()
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
    readJson: vi.fn((path: string) => Promise.resolve(
      path.includes("journey") ? runtimeJourney : runtimeConfig
    )),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

describe("knowledge feature-map", () => {
  it("emits the structured projection as one JSON value", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "knowledge", "feature-map",
      "--project", "/project",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as FeatureMapProjection;
    expect(output.packageName).toBe("dev.taphound.demo");
    expect(output.knowledgeHash).toBe(bundle.knowledgeHash);
    expect(output.features).toHaveLength(1);
    expect(output.entryScreens[0]?.id).toBe("demo.main.screen");
    expect(output.transitions[0]?.id).toBe("demo.main.open_search");
  });

  it("emits the low-token Markdown projection", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "knowledge", "feature-map",
      "--project", "/project",
      "--markdown"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = (dependencies.stdout as BufferOutput).value;
    expect(output).toContain("# Feature Map: dev.taphound.demo");
    expect(output).toContain("## demo.main.screen");
    expect(output).toContain("- demo.main.open_search: demo.main.screen → demo.search.screen");
  });

  it("emits a summary line without flags", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "knowledge", "feature-map",
      "--project", "/project"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = (dependencies.stdout as BufferOutput).value;
    expect(output).toContain("1 feature(s)");
  });

  it("fails when Knowledge services are unavailable", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.knowledge = undefined;
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "knowledge", "feature-map",
      "--project", "/project",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { status: string; code: string };
    expect(output.status).toBe("failed");
    expect(output.code).toBe("KNOWLEDGE_INVALID");
  });
});