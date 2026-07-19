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

  it("rejects an empty Locator", () => {
    expect(() => LocatorSchema.parse({})).toThrow();
  });

  it("rejects XPath and direct coordinates", () => {
    expect(() => LocatorSchema.parse({ xpath: "//button" })).toThrow();
    expect(() => LocatorSchema.parse({ x: 10, y: 20 })).toThrow();
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
