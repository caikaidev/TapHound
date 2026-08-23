import { describe, expect, it } from "vitest";

import {
  BoundsSchema,
  LayoutElementSchema,
  LocatorSchema
} from "../../src/domain/layout.js";

describe("LocatorSchema", () => {
  it.each([
    { resourceId: "toolbar_search" },
    { text: "Search" },
    { contentDescription: "Open search" }
  ])("accepts a supported Locator", (locator) => {
    expect(LocatorSchema.parse(locator)).toEqual(locator);
  });

  it("allows multiple fields for deterministic narrowing", () => {
    const locator = {
      resourceId: "search",
      contentDescription: "Open search"
    };

    expect(LocatorSchema.parse(locator)).toEqual(locator);
  });

  it("accepts an ordinal after identity narrowing", () => {
    const locator = { resourceId: "row", text: "Item", index: 2 };

    expect(LocatorSchema.parse(locator)).toEqual(locator);
  });

  it("accepts versioned semantic evidence only with an ordinal", () => {
    const evidence = {
      version: 1 as const,
      semanticSha256: "a".repeat(64)
    };

    expect(LocatorSchema.parse({
      resourceId: "row",
      index: 0,
      evidence
    })).toMatchObject({ evidence });
    expect(() => LocatorSchema.parse({
      resourceId: "row",
      evidence
    })).toThrow(/requires index/i);
  });

  it("accepts a recursively scoped Locator", () => {
    const locator = {
      text: "Item",
      within: {
        resourceId: "results",
        within: { contentDescription: "Main panel" }
      }
    };

    expect(LocatorSchema.parse(locator)).toEqual(locator);
  });

  it("rejects an empty Locator", () => {
    expect(() => LocatorSchema.parse({})).toThrow();
  });

  it("rejects XPath and direct coordinates", () => {
    expect(() => LocatorSchema.parse({ xpath: "//button" })).toThrow();
    expect(() => LocatorSchema.parse({ x: 10, y: 20 })).toThrow();
  });

  it("rejects invalid ordinals and unknown fields at every scope", () => {
    expect(() => LocatorSchema.parse({ text: "Item", index: -1 })).toThrow();
    expect(() => LocatorSchema.parse({
      text: "Item",
      within: { resourceId: "results", xpath: "//list" }
    })).toThrow();
  });
});

describe("BoundsSchema", () => {
  it("requires positive area", () => {
    expect(() => BoundsSchema.parse({
      left: 10,
      top: 10,
      right: 10,
      bottom: 20
    })).toThrow();
  });
});

describe("LayoutElementSchema", () => {
  it("supports nested normalized Layout elements", () => {
    const element = LayoutElementSchema.parse({
      id: "root/0",
      resourceId: "toolbar_search",
      clickable: true,
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      children: []
    });

    expect(element.children).toEqual([]);
  });
});
