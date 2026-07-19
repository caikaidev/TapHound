import { describe, expect, it } from "vitest";

import type { LayoutElement } from "../../../src/domain/layout.js";
import { resolveLocator } from "../../../src/application/locator/locator-resolver.js";

function element(
  overrides: Partial<LayoutElement> = {}
): LayoutElement {
  return {
    id: "element",
    enabled: true,
    bounds: { left: 10, top: 20, right: 110, bottom: 80 },
    children: [],
    ...overrides
  };
}

describe("resolveLocator", () => {
  it("uses resourceId before lower-priority Locator fields", () => {
    const target = element({
      id: "target",
      resourceId: "search",
      text: "Actual"
    });

    const result = resolveLocator([target], {
      resourceId: "search",
      text: "Different"
    });

    expect(result).toMatchObject({
      status: "found",
      element: { id: "target" },
      matchedBy: "resourceId"
    });
  });

  it("falls back to text when resourceId has no matches", () => {
    const target = element({ text: "Search" });

    expect(resolveLocator([target], {
      resourceId: "missing",
      text: "Search"
    })).toMatchObject({
      status: "found",
      matchedBy: "text"
    });
  });

  it("uses lower-priority fields to narrow an ambiguous match", () => {
    const roots = [
      element({ id: "one", resourceId: "row", text: "First" }),
      element({ id: "two", resourceId: "row", text: "Second" })
    ];

    expect(resolveLocator(roots, {
      resourceId: "row",
      text: "Second"
    })).toMatchObject({
      status: "found",
      element: { id: "two" },
      matchedBy: "text"
    });
  });

  it("reports no match and ambiguity separately", () => {
    expect(resolveLocator([element()], { text: "missing" })).toMatchObject({
      status: "failed",
      code: "LOCATOR_NOT_FOUND"
    });

    expect(resolveLocator([
      element({ id: "one", text: "same" }),
      element({ id: "two", text: "same" })
    ], { text: "same" })).toMatchObject({
      status: "failed",
      code: "LOCATOR_AMBIGUOUS"
    });
  });

  it("rejects a disabled target as an Action failure", () => {
    expect(resolveLocator([
      element({ enabled: false, resourceId: "search" })
    ], { resourceId: "search" })).toMatchObject({
      status: "failed",
      code: "ACTION_FAILED"
    });
  });

  it("calculates the element center point", () => {
    expect(resolveLocator([
      element({
        resourceId: "search",
        bounds: { left: 10, top: 20, right: 111, bottom: 81 }
      })
    ], { resourceId: "search" })).toMatchObject({
      status: "found",
      point: { x: 61, y: 51 }
    });
  });

  it("searches nested Layout elements", () => {
    const root = element({
      id: "root",
      children: [element({ id: "nested", contentDescription: "Open search" })]
    });

    expect(resolveLocator([root], {
      contentDescription: "Open search"
    })).toMatchObject({
      status: "found",
      element: { id: "nested" }
    });
  });
});
