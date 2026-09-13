import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeAnchorResolver
} from "../../../src/application/knowledge/anchor-resolver.js";
import type { LoadedKnowledgeBundle } from "../../../src/ports/knowledge-registry.js";

const searchElement = {
  id: "search",
  resourceId: "search",
  enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 50 },
  children: []
};

const openElement = {
  id: "open",
  resourceId: "search_open",
  text: "Open",
  enabled: true,
  bounds: { left: 10, top: 10, right: 110, bottom: 60 },
  children: []
};

import type {
  AnchorCandidate
} from "../../../src/domain/knowledge.js";

function bundle(candidates?: AnchorCandidate[]): LoadedKnowledgeBundle {
  return {
    index: {
      version: 1,
      packageName: "dev.taphound.demo",
      revision: 0,
      anchors: [{
        id: "demo.search.open",
        path: "anchors/demo.search.open.json",
        sha256: "a".repeat(64),
        status: "observed"
      }],
      screens: [],
      transitions: []
    },
    indexSha256: "0".repeat(64),
    knowledgeHash: "a".repeat(64),
    anchors: [{
      version: 1,
      id: "demo.search.open",
      status: "observed",
      roles: ["actionable"],
      identity: {
        kind: "element",
        locator: { resourceId: "search_open" }
      },
      ...(candidates === undefined ? {} : { candidates })
    }],
    screens: [],
    transitions: []
  };
}

function resolver(bundleInput: LoadedKnowledgeBundle): KnowledgeAnchorResolver {
  return new KnowledgeAnchorResolver({
    load: vi.fn(() => Promise.resolve(bundleInput))
  }, "/project");
}

describe("KnowledgeAnchorResolver semantic chain", () => {
  it("falls back from composeSemantics to resourceId and records fallback", async () => {
    const chainResolver = resolver(bundle([
      { kind: "composeSemantics", locator: { contentDescription: "Open" } },
      { kind: "resourceId", locator: { resourceId: "search_open" } }
    ]));
    const resolution = await chainResolver.resolve({
      anchorId: "demo.search.open",
      layout: [searchElement, openElement]
    });
    expect(resolution.status).toBe("found");
    expect(resolution.resolvedBy).toEqual({
      kind: "resourceId",
      confidence: "fallback"
    });
    expect(resolution.point).toEqual({ x: 60, y: 35 });
  });

  it("records primary when the first candidate resolves", async () => {
    const chainResolver = resolver(bundle([
      { kind: "composeSemantics", locator: { text: "Open" } },
      { kind: "resourceId", locator: { resourceId: "search_open" } }
    ]));
    const resolution = await chainResolver.resolve({
      anchorId: "demo.search.open",
      layout: [openElement]
    });
    expect(resolution.status).toBe("found");
    expect(resolution.resolvedBy).toEqual({
      kind: "composeSemantics",
      confidence: "primary"
    });
  });

  it("fails closed as visualOnly when only visualMatch remains", async () => {
    const visualResolver = resolver(bundle([
      { kind: "contentDescription", locator: { contentDescription: "Missing" } },
      { kind: "visualMatch", locator: { text: "x" } }
    ]));
    const resolution = await visualResolver.resolve({
      anchorId: "demo.search.open",
      layout: [openElement]
    });
    expect(resolution.status).toBe("visualOnly");
    expect(resolution.message).toContain("visualMatch");
  });

  it("keeps legacy single-locator anchors on the primary path", async () => {
    const legacyResolver = resolver(bundle());
    const resolution = await legacyResolver.resolve({
      anchorId: "demo.search.open",
      layout: [openElement]
    });
    expect(resolution.status).toBe("found");
    expect(resolution.resolvedBy).toEqual({
      kind: "resourceId",
      confidence: "primary"
    });
  });

  it("reports notFound when no candidate matches and no visualMatch exists", async () => {
    const missResolver = resolver(bundle([
      { kind: "resourceId", locator: { resourceId: "nope" } }
    ]));
    const resolution = await missResolver.resolve({
      anchorId: "demo.search.open",
      layout: [openElement]
    });
    expect(resolution.status).toBe("notFound");
  });
});