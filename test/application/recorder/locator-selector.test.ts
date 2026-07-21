import { describe, expect, it } from "vitest";

import {
  listLocatableTargets,
  listRecorderTargets,
  selectUniqueLocator
} from "../../../src/application/recorder/locator-selector.js";
import type { LayoutElement } from "../../../src/domain/layout.js";

const elements: LayoutElement[] = [{
  id: "root",
  enabled: true,
  bounds: { left: 0, top: 0, right: 300, bottom: 600 },
  children: [{
    id: "search",
    resourceId: "search_button",
    text: "Search",
    contentDescription: "Open search",
    clickable: true,
    longClickable: true,
    enabled: true,
    bounds: { left: 10, top: 10, right: 100, bottom: 60 },
    children: []
  }, {
    id: "duplicate-a",
    text: "Item",
    clickable: true,
    enabled: true,
    bounds: { left: 10, top: 80, right: 100, bottom: 130 },
    children: []
  }, {
    id: "duplicate-b",
    text: "Item",
    contentDescription: "Second item",
    clickable: true,
    enabled: true,
    bounds: { left: 10, top: 140, right: 100, bottom: 190 },
    children: []
  }, {
    id: "disabled",
    resourceId: "disabled",
    clickable: true,
    enabled: false,
    bounds: { left: 10, top: 200, right: 100, bottom: 250 },
    children: []
  }, {
    id: "results",
    resourceId: "results",
    scrollable: true,
    enabled: true,
    bounds: { left: 0, top: 260, right: 300, bottom: 600 },
    children: []
  }]
}];

describe("Recorder locator selection", () => {
  it("uses the first nonempty unique identity in protocol priority order", () => {
    const search = listRecorderTargets(elements, "click").find(
      (choice) => choice.element.id === "search"
    );
    const second = listRecorderTargets(elements, "click").find(
      (choice) => choice.element.id === "duplicate-b"
    );
    if (search === undefined || second === undefined) {
      throw new Error("Expected Recorder targets are missing");
    }
    expect(selectUniqueLocator(search.element, elements))
      .toEqual({ resourceId: "search_button" });
    expect(selectUniqueLocator(second.element, elements))
      .toEqual({ contentDescription: "Second item" });
  });

  it("lists only enabled elements that have a deterministic Locator", () => {
    expect(listRecorderTargets(elements, "click").map((choice) => choice.element.id))
      .toEqual(["search", "duplicate-b"]);
    expect(listRecorderTargets(elements, "click")[0]?.label)
      .toContain("search_button");
  });

  it("filters targets by the selected Action interaction", () => {
    expect(listRecorderTargets(elements, "longClick").map(
      (choice) => choice.element.id
    )).toEqual(["search"]);
    expect(listRecorderTargets(elements, "swipe").map(
      (choice) => choice.element.id
    )).toEqual(["results"]);
  });
});

describe("listLocatableTargets", () => {
  it("lists enabled elements with a unique locator regardless of clickability", () => {
    const targets = listLocatableTargets([{
      id: "bubble",
      resourceId: "message_bubble",
      text: "hello",
      enabled: true,
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      children: []
    }]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.locator).toEqual({ resourceId: "message_bubble" });
  });

  it("skips disabled elements", () => {
    const targets = listLocatableTargets([{
      id: "bubble",
      resourceId: "message_bubble",
      enabled: false,
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      children: []
    }]);
    expect(targets).toHaveLength(0);
  });
});
