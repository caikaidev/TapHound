import { describe, expect, it } from "vitest";

import { hashGenerationBinding } from "../../../src/application/generation/generation-starter.js";
import { JourneyCheckService } from "../../../src/application/journey/journey-check-service.js";
import type { ProjectDescription } from "../../../src/application/project/project-describer.js";
import type {
  JourneyCompositionStore
} from "../../../src/ports/journey-composition-store.js";
import { runtimeConfig, runtimeJourney } from "../../fakes/runtime-fixture.js";
import {
  contextSelection,
  projectContextIndex
} from "../../fixtures/project-context.js";

const project: ProjectDescription = {
  projectRoot: "/project",
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity"
};

const projectHash = hashGenerationBinding(project);
const configHash = hashGenerationBinding(runtimeConfig);

interface FakeStoreOptions {
  journeys?: Record<string, string>;
  metas?: Record<string, string>;
  journeyReadFailures?: string[];
  metaReadFailures?: string[];
}

function fakeStore(options: FakeStoreOptions = {
}): Pick<JourneyCompositionStore, "read" | "listJourneyPaths" | "readJourneyMeta"> {
  const journeys = options.journeys ?? {};
  const metas = options.metas ?? {};
  const journeyFailures = new Set(options.journeyReadFailures ?? []);
  const metaFailures = new Set(options.metaReadFailures ?? []);
  return {
    listJourneyPaths: () => Promise.resolve(Object.keys(journeys).sort()),
    read: ({ relativePath }): Promise<Buffer> => {
      if (journeyFailures.has(relativePath)) {
        throw new Error(`Unable to safely read ${relativePath}: unreadable`);
      }
      const content = journeys[relativePath];
      if (content === undefined) {
        throw new Error(`Unable to safely read ${relativePath}: notFound`);
      }
      return Promise.resolve(Buffer.from(content, "utf8"));
    },
    readJourneyMeta: ({ journeyPath }): Promise<Buffer | null> => {
      if (metaFailures.has(journeyPath)) {
        throw new Error(`Unable to safely read ${journeyPath}: unreadable`);
      }
      const content = metas[journeyPath];
      return content === undefined
        ? Promise.resolve(null)
        : Promise.resolve(Buffer.from(content, "utf8"));
    }
  };
}

function metaJson(overrides: {
  journeyPath?: string;
  projectHash?: string;
  configHash?: string;
  contextSelection?: Record<string, unknown> | null;
} = {}): string {
  return `${JSON.stringify({
    version: 1,
    status: "verified",
    generationId: "generation-1",
    journeyPath: overrides.journeyPath ?? ".taphound/journeys/search.json",
    bindings: {
      projectHash: overrides.projectHash ?? projectHash,
      configHash: overrides.configHash ?? configHash,
      contextHash: "c".repeat(64)
    },
    ...(overrides.contextSelection === null
      ? {}
      : { contextSelection: overrides.contextSelection ?? contextSelection }),
    verification: {
      reportPath: "verification/report.json",
      reportSha256: "d".repeat(64),
      runId: "verify-run",
      runs: 1
    },
    manualOverrideStepIndexes: []
  })}\n`;
}

function service(
  options: FakeStoreOptions = {}
): JourneyCheckService {
  return new JourneyCheckService({ store: fakeStore(options) });
}

async function check(
  options: FakeStoreOptions = {}
): Promise<Awaited<ReturnType<JourneyCheckService["check"]>>> {
  return service(options).check({
    projectRoot: "/project",
    config: runtimeConfig,
    project,
    bundle: projectContextIndex
  });
}

describe("JourneyCheckService", () => {
  it("classifies a fully bound Journey as fresh", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: { ".taphound/journeys/search.json": metaJson() }
    });

    expect(result.entries).toEqual([{
      name: "search",
      journeyPath: ".taphound/journeys/search.json",
      metaPath: ".taphound/journeys/search.meta.json",
      status: "fresh",
      lifecycle: "verified",
      reasons: [],
      driftedModules: [],
      message: undefined
    }]);
    expect(result.summary).toEqual({
      total: 1,
      fresh: 1,
      stale: 0,
      noMeta: 0,
      invalid: 0
    });
  });

  it("classifies a Journey without a sidecar as no-meta", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      }
    });

    expect(result.entries[0]?.status).toBe("no-meta");
    expect(result.entries[0]?.reasons).toEqual([]);
    expect(result.summary.noMeta).toBe(1);
  });

  it("reports stale project, config, and journey path bindings", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: {
        ".taphound/journeys/search.json": metaJson({
          journeyPath: ".taphound/journeys/renamed.json",
          projectHash: "0".repeat(64),
          configHash: "1".repeat(64)
        })
      }
    });

    expect(result.entries[0]?.status).toBe("stale");
    expect(result.entries[0]?.reasons).toEqual([
      "journey-path-mismatch",
      "project-hash",
      "config-hash"
    ]);
  });

  it("reports legacy metas without a Context selection as stale", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: {
        ".taphound/journeys/search.json": metaJson({
          contextSelection: null
        })
      }
    });

    expect(result.entries[0]?.status).toBe("stale");
    expect(result.entries[0]?.reasons).toEqual(["meta-legacy"]);
  });

  it("attributes drifted and missing Context modules per Journey", async () => {
    const drifted = JSON.parse(metaJson()) as {
      contextSelection: { modules: { id: string; sha256: string }[] };
    };
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: {
        ".taphound/journeys/search.json": JSON.stringify({
          ...drifted,
          contextSelection: {
            ...drifted.contextSelection,
            modules: [
              { ...drifted.contextSelection.modules[0], sha256: "9".repeat(64) },
              {
                id: ":feature:gone",
                sha256: "8".repeat(64),
                projectDir: "feature/gone",
                inventory: {
                  pathSetSha256: "7".repeat(64),
                  categories: ["sources"]
                }
              }
            ]
          }
        })
      }
    });

    expect(result.entries[0]?.status).toBe("stale");
    expect(result.entries[0]?.reasons).toEqual(["module-drift", "module-missing"]);
    expect(result.entries[0]?.driftedModules).toEqual([
      { id: ":app", reason: "sha256" },
      { id: ":feature:gone", reason: "missing" }
    ]);
  });

  it("reports unreadable and schema-invalid Journeys as invalid", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/broken.json": "{\"version\":2,}\n",
        ".taphound/journeys/gone.json": "{}\n",
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`,
        ".taphound/journeys/wrong.json": "{}\n"
      },
      metas: { ".taphound/journeys/search.json": metaJson() },
      journeyReadFailures: [".taphound/journeys/gone.json"]
    });

    const byPath = new Map(result.entries.map((entry) => [
      entry.journeyPath,
      entry
    ]));
    expect(byPath.get(".taphound/journeys/broken.json")?.status).toBe("invalid");
    expect(byPath.get(".taphound/journeys/broken.json")?.reasons).toEqual([
      "journey-schema"
    ]);
    expect(byPath.get(".taphound/journeys/wrong.json")?.reasons).toEqual([
      "journey-schema"
    ]);
    expect(byPath.get(".taphound/journeys/gone.json")?.reasons).toEqual([
      "journey-unreadable"
    ]);
    expect(byPath.get(".taphound/journeys/gone.json")?.message).toContain(
      "gone.json"
    );
    expect(result.summary).toEqual({
      total: 4,
      fresh: 1,
      stale: 0,
      noMeta: 0,
      invalid: 3
    });
  });

  it("reports unreadable and schema-invalid metas as invalid", async () => {
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: { ".taphound/journeys/search.json": "{\"version\":9}\n" }
    });

    expect(result.entries[0]?.status).toBe("invalid");
    expect(result.entries[0]?.reasons).toEqual(["meta-schema"]);

    const unreadable = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: { ".taphound/journeys/search.json": metaJson() },
      metaReadFailures: [".taphound/journeys/search.json"]
    });
    expect(unreadable.entries[0]?.reasons).toEqual(["meta-unreadable"]);
  });

  it("derives nested names and returns an empty result for no Journeys", async () => {
    const nested = await check({
      journeys: {
        ".taphound/journeys/chat/send.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: { ".taphound/journeys/chat/send.json": metaJson({
        journeyPath: ".taphound/journeys/chat/send.json"
      }) }
    });

    expect(nested.entries[0]?.name).toBe("chat/send");
    expect(nested.entries[0]?.metaPath).toBe(
      ".taphound/journeys/chat/send.meta.json"
    );

    const empty = await check();
    expect(empty.entries).toEqual([]);
    expect(empty.summary).toEqual({
      total: 0,
      fresh: 0,
      stale: 0,
      noMeta: 0,
      invalid: 0
    });
  });

  it("classifies an explicitly retired Journey as retired regardless of drift", async () => {
    const retiredMeta = JSON.parse(metaJson({
      projectHash: "0".repeat(64)
    })) as Record<string, unknown>;
    retiredMeta.retired = {
      retiredAt: "2026-09-11T00:00:00.000Z",
      reason: "superseded"
    };
    const result = await check({
      journeys: {
        ".taphound/journeys/search.json": `${JSON.stringify(runtimeJourney)}\n`
      },
      metas: {
        ".taphound/journeys/search.json": `${JSON.stringify(retiredMeta)}\n`
      }
    });

    expect(result.entries[0]?.lifecycle).toBe("retired");
    expect(result.entries[0]?.status).toBe("stale");
  });
});
