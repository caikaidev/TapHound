import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeAnchorResolver
} from "../../../src/application/knowledge/anchor-resolver.js";
import type { LoadedKnowledgeBundle } from "../../../src/ports/knowledge-registry.js";

const element = {
  id: "search",
  resourceId: "search",
  enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 50 },
  children: []
};

function bundle(): LoadedKnowledgeBundle {
  const anchors = [{
    version: 1 as const,
    id: "demo.search.open",
    status: "observed" as const,
    roles: ["actionable" as const],
    identity: {
      kind: "element" as const,
      locator: { resourceId: "search" }
    },
    description: "Opens the search screen"
  }, {
    version: 1 as const,
    id: "demo.search.window",
    status: "observed" as const,
    roles: ["screenIdentity" as const],
    identity: {
      kind: "window" as const,
      title: "SearchActivity"
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
        sha256: "a".repeat(64),
        status: "observed" as const
      }, {
        id: "demo.search.window",
        path: "anchors/demo.search.window.json",
        sha256: "b".repeat(64),
        status: "observed" as const
      }],
      screens: [{
        id: "demo.search.screen",
        path: "screens/demo.search.screen.json",
        sha256: "c".repeat(64),
        status: "observed" as const
      }],
      transitions: []
    },
    indexSha256: "d".repeat(64),
    knowledgeHash: "e".repeat(64),
    anchors,
    screens: [],
    transitions: []
  };
}

describe("KnowledgeAnchorResolver", () => {
  it("resolves an element anchor against a fresh layout", async () => {
    const registry = {
      load: vi.fn((): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle()))
    };
    const resolver = new KnowledgeAnchorResolver(registry, "/project");

    const result = await resolver.resolve({
      anchorId: "demo.search.open",
      layout: [element]
    });

    expect(result).toMatchObject({
      status: "found",
      point: { x: 50, y: 25 },
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      element: { id: "search" }
    });
  });

  it("returns notFound when the anchor id is not defined", async () => {
    const registry = {
      load: vi.fn((): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle()))
    };
    const resolver = new KnowledgeAnchorResolver(registry, "/project");

    const result = await resolver.resolve({
      anchorId: "demo.search.missing",
      layout: [element]
    });

    expect(result.status).toBe("notFound");
    expect(result.message).toContain("demo.search.missing");
  });

  it("fails closed for non-element anchor identities", async () => {
    const registry = {
      load: vi.fn((): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle()))
    };
    const resolver = new KnowledgeAnchorResolver(registry, "/project");

    const result = await resolver.resolve({
      anchorId: "demo.search.window",
      layout: [element]
    });

    expect(result.status).toBe("notFound");
    expect(result.message).toContain("element locator identity");
  });

  it("returns notFound when the anchor locator matches nothing", async () => {
    const registry = {
      load: vi.fn((): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle()))
    };
    const resolver = new KnowledgeAnchorResolver(registry, "/project");

    const result = await resolver.resolve({
      anchorId: "demo.search.open",
      layout: [{
        id: "other",
        text: "different",
        enabled: true,
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
        children: []
      }]
    });

    expect(result.status).toBe("notFound");
  });
});