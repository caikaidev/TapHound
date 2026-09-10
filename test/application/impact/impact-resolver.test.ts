import { describe, expect, it } from "vitest";

import {
  ImpactResolver
} from "../../../src/application/impact/impact-resolver.js";
import type { ChangeSet } from "../../../src/domain/impact.js";
import type { ProjectContextModule } from "../../../src/domain/project-context.js";
import type { LoadedKnowledgeBundle } from "../../../src/ports/knowledge-registry.js";

const moduleFixture: ProjectContextModule = {
  version: 2,
  moduleId: "app",
  projectDir: "app/src/main",
  status: "complete",
  inventory: {
    version: 2,
    pathSetSha256: "a".repeat(64),
    categories: ["sources", "layouts"]
  },
  manifest: {
    version: 1,
    files: [{
      path: "app/src/main/res/layout/activity_main.xml",
      sha256: "b".repeat(64),
      confidence: "sourceConfirmed"
    }]
  },
  summary: {
    features: ["search"],
    activities: [{
      name: "dev.taphound.demo.MainActivity",
      entryPoints: ["dev.taphound.demo.MainActivity"],
      screens: ["main"]
    }],
    elements: [{
      screen: "main",
      resourceId: "open_search",
      actions: ["click"]
    }],
    transitions: [{
      fromActivity: "dev.taphound.demo.MainActivity",
      actionResourceId: "open_search",
      toActivity: "dev.taphound.demo.SearchActivity"
    }],
    logcat: []
  }
};

function knowledgeFixture(): LoadedKnowledgeBundle {
  const anchors = [{
    version: 1 as const,
    id: "demo.search.open",
    status: "verified" as const,
    roles: ["actionable" as const],
    identity: {
      kind: "element" as const,
      locator: { resourceId: "open_search" }
    },
    sourceFiles: ["app/src/main/res/layout/activity_main.xml"]
  }, {
    version: 1 as const,
    id: "demo.search.input",
    status: "verified" as const,
    roles: ["actionable" as const],
    identity: {
      kind: "element" as const,
      locator: { resourceId: "search_input" }
    }
  }];
  return {
    index: {
      version: 1,
      packageName: "dev.taphound.demo",
      revision: 0,
      anchors: [{
        id: "demo.search.open",
        path: "anchors/demo.search.open.json",
        sha256: "c".repeat(64),
        status: "verified"
      }, {
        id: "demo.search.input",
        path: "anchors/demo.search.input.json",
        sha256: "d".repeat(64),
        status: "verified"
      }],
      screens: [{
        id: "demo.search.screen",
        path: "screens/demo.search.screen.json",
        sha256: "e".repeat(64),
        status: "verified"
      }],
      transitions: [{
        id: "demo.main.open_search",
        path: "transitions/demo.main.open_search.json",
        sha256: "f".repeat(64),
        status: "verified"
      }]
    },
    indexSha256: "a1".repeat(32),
    knowledgeHash: "b1".repeat(32),
    anchors,
    screens: [{
      version: 1,
      id: "demo.main.screen",
      status: "observed",
      requiredAnchors: ["demo.search.open"],
      optionalAnchors: [],
      forbiddenAnchors: [],
      predicates: []
    }, {
      version: 1,
      id: "demo.search.screen",
      status: "observed",
      requiredAnchors: ["demo.search.input"],
      optionalAnchors: [],
      forbiddenAnchors: ["demo.search.open"],
      predicates: []
    }],
    transitions: [{
      version: 1,
      id: "demo.main.open_search",
      status: "verified",
      fromScreen: "demo.main.screen",
      toScreen: "demo.search.screen",
      semantic: "openSearch",
      action: {
        action: "click",
        anchorId: "demo.search.open"
      },
      verification: {
        targetScreen: "demo.search.screen",
        timeoutMs: 10000
      },
      observations: { attempts: 0, successes: 0, recoveryCost: 0 }
    }]
  };
}

function resolver(overrides: {
  journeys?: Record<string, unknown>;
} = {}): ImpactResolver {
  const journeys = overrides.journeys ?? {
    ".taphound/journeys/anchored-search.json": {
      version: 2,
      name: "anchored-search",
      devices: [{ role: "default" }],
      steps: [{
        action: "click",
        anchor: "demo.search.open",
        locator: { resourceId: "open_search" },
        activity: {
          before: "dev.taphound.demo.MainActivity",
          after: "dev.taphound.demo.SearchActivity"
        }
      }]
    },
    ".taphound/journeys/generated-search.json": {
      version: 2,
      name: "generated-search",
      devices: [{ role: "default" }],
      steps: [{
        action: "click",
        locator: { resourceId: "open_search" },
        activity: {
          before: "dev.taphound.demo.MainActivity",
          after: "dev.taphound.demo.SearchActivity"
        }
      }]
    }
  };
  return new ImpactResolver({
    loadContext: (): Promise<{
      context: never;
      modules: ProjectContextModule[];
    }> => Promise.resolve({
      context: {} as never,
      modules: [moduleFixture]
    }),
    loadKnowledge: (): Promise<LoadedKnowledgeBundle> => (
      Promise.resolve(knowledgeFixture())
    ),
    listJourneyPaths: (): Promise<readonly string[]> => (
      Promise.resolve(Object.keys(journeys))
    ),
    readJourney: ({ path }): Promise<never> => Promise.resolve(
      (journeys[path] ?? null) as never
    )
  });
}

describe("ImpactResolver", () => {
  it("maps changed files through modules, Knowledge, and the semantic graph", async () => {
    const changeSet: ChangeSet = {
      version: 1,
      base: "origin/main",
      head: "HEAD",
      files: [{
        path: "app/src/main/res/layout/activity_main.xml",
        status: "modified"
      }]
    };
    const impact = await resolver().resolve("/project", changeSet);

    expect(impact.affectedModules).toEqual(["app"]);
    expect(impact.affectedFeatures).toEqual(["search"]);
    expect(impact.affectedAnchors).toEqual(["demo.search.open"]);
    expect(impact.affectedScreens).toEqual([
      "demo.main.screen",
      "demo.search.screen"
    ]);
    expect(impact.affectedTransitions).toEqual(["demo.main.open_search"]);
    expect(impact.selectedJourneys.p0).toMatchObject([{
      id: ".taphound/journeys/anchored-search.json"
    }]);
    expect(impact.selectedJourneys.p1).toEqual([]);
  });

  it("skips journeys that only use runtime locators", async () => {
    const changeSet: ChangeSet = {
      version: 1,
      base: "origin/main",
      head: "HEAD",
      files: [{
        path: "app/src/main/res/layout/activity_main.xml",
        status: "modified"
      }]
    };
    const impact = await resolver().resolve("/project", changeSet);

    expect(impact.skippedJourneys).toEqual([{
      id: ".taphound/journeys/generated-search.json",
      reason: "journey uses only runtime locators; no semantic anchor binding"
    }]);
  });

  it("reports an empty selection when no file maps to Knowledge", async () => {
    const changeSet: ChangeSet = {
      version: 1,
      base: "origin/main",
      head: "HEAD",
      files: [{
        path: "docs/report-schema.md",
        status: "modified"
      }]
    };
    const impact = await resolver().resolve("/project", changeSet);

    expect(impact.affectedModules).toEqual([]);
    expect(impact.affectedAnchors).toEqual([]);
    expect(impact.selectedJourneys.p0).toEqual([]);
  });

  it("propagates anchor changes into screens and journeys via sourceFiles", async () => {
    const changeSet: ChangeSet = {
      version: 1,
      base: "origin/main",
      head: "HEAD",
      files: [{
        path: "app/src/main/res/layout/activity_main.xml",
        status: "deleted"
      }]
    };
    const resolverInstance = resolver();
    const impact = await resolverInstance.resolve("/project", changeSet);

    expect(impact.affectedAnchors).toContain("demo.search.open");
    expect(impact.selectedJourneys.p0[0]?.id)
      .toBe(".taphound/journeys/anchored-search.json");
  });
});