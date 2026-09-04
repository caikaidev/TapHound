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

  it("lists enabled duplicate elements with deterministic ordinal Locators", () => {
    expect(listRecorderTargets(elements, "click").map((choice) => choice.element.id))
      .toEqual(["search", "duplicate-a", "duplicate-b"]);
    const duplicateLocator = listRecorderTargets(elements, "click")[1]?.locator;
    expect(duplicateLocator).toMatchObject({ text: "Item", index: 0 });
    expect(duplicateLocator?.evidence?.version).toBe(1);
    expect(duplicateLocator?.evidence?.semanticSha256).toMatch(/^[a-f\d]{64}$/);
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

  it("does not list a geometry-free structure node as an action target", () => {
    const structure: LayoutElement = {
      id: "structure",
      resourceId: "structure",
      clickable: true,
      longClickable: true,
      scrollable: true,
      enabled: true,
      children: []
    };

    expect(listRecorderTargets([structure], "click")).toEqual([]);
    expect(listRecorderTargets([structure], "longClick")).toEqual([]);
    expect(listRecorderTargets([structure], "swipe")).toEqual([]);
  });
});

const orphanRowLayout: LayoutElement[] = [{
  id: "root",
  enabled: true,
  bounds: { left: 0, top: 0, right: 300, bottom: 600 },
  children: [{
    id: "chrome",
    resourceId: "toolbar_search",
    clickable: true,
    longClickable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 300, bottom: 50 },
    children: []
  }, {
    id: "row",
    clickable: true,
    longClickable: true,
    enabled: true,
    bounds: { left: 0, top: 60, right: 300, bottom: 160 },
    children: []
  }, {
    id: "subject",
    text: "Unique subject",
    enabled: true,
    bounds: { left: 10, top: 70, right: 200, bottom: 100 },
    children: []
  }, {
    id: "sender-a",
    text: "Same sender",
    enabled: true,
    bounds: { left: 10, top: 110, right: 200, bottom: 140 },
    children: []
  }, {
    id: "sender-b",
    text: "Same sender",
    enabled: true,
    bounds: { left: 10, top: 170, right: 200, bottom: 200 },
    children: []
  }, {
    id: "disabled-desc",
    contentDescription: "Disabled item",
    enabled: false,
    bounds: { left: 10, top: 210, right: 200, bottom: 240 },
    children: []
  }]
}];

const clickOnlyOrphanLayout: LayoutElement[] = [{
  id: "root",
  enabled: true,
  bounds: { left: 0, top: 0, right: 300, bottom: 600 },
  children: [{
    id: "chrome",
    resourceId: "toolbar_search",
    clickable: true,
    longClickable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 300, bottom: 50 },
    children: []
  }, {
    id: "row",
    clickable: true,
    enabled: true,
    bounds: { left: 0, top: 60, right: 300, bottom: 160 },
    children: []
  }, {
    id: "subject",
    text: "Unique subject",
    enabled: true,
    bounds: { left: 10, top: 70, right: 200, bottom: 100 },
    children: []
  }]
}];

const noOrphanLayout: LayoutElement[] = [{
  id: "root",
  enabled: true,
  bounds: { left: 0, top: 0, right: 300, bottom: 600 },
  children: [{
    id: "chrome",
    resourceId: "toolbar_search",
    clickable: true,
    longClickable: true,
    enabled: true,
    bounds: { left: 0, top: 0, right: 300, bottom: 50 },
    children: []
  }, {
    id: "label",
    text: "Standalone label",
    enabled: true,
    bounds: { left: 10, top: 70, right: 200, bottom: 100 },
    children: []
  }]
}];

describe("Recorder relaxed content targets", () => {
  it("appends ordinal content targets after interactive ones when a click orphan exists", () => {
    expect(listRecorderTargets(orphanRowLayout, "click").map(
      (choice) => choice.element.id
    )).toEqual(["chrome", "subject", "sender-a", "sender-b"]);
  });

  it("does not append content targets for longClick even when an orphan exists", () => {
    expect(listRecorderTargets(orphanRowLayout, "longClick").map(
      (choice) => choice.element.id
    )).toEqual(["chrome"]);
  });

  it("locates a relaxed content target by its text field", () => {
    const subject = listRecorderTargets(orphanRowLayout, "click").find(
      (choice) => choice.element.id === "subject"
    );
    expect(subject?.locator).toEqual({ text: "Unique subject" });
  });

  it("does not activate the longClick fallback for a click-only orphan", () => {
    expect(listRecorderTargets(clickOnlyOrphanLayout, "click").map(
      (choice) => choice.element.id
    )).toEqual(["chrome", "subject"]);
    expect(listRecorderTargets(clickOnlyOrphanLayout, "longClick").map(
      (choice) => choice.element.id
    )).toEqual(["chrome"]);
  });

  it("does not list non-interactive content when no orphan exists", () => {
    expect(listRecorderTargets(noOrphanLayout, "click").map(
      (choice) => choice.element.id
    )).toEqual(["chrome"]);
  });

  it("leaves swipe target selection unchanged", () => {
    expect(listRecorderTargets(orphanRowLayout, "swipe")).toEqual([]);
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

  it("prefers a stable ancestor scope over a global ordinal", () => {
    const roots: LayoutElement[] = [
      {
        id: "first",
        resourceId: "first_list",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: [{
          id: "first-item",
          text: "Item",
          enabled: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 40 },
          children: []
        }]
      },
      {
        id: "second",
        resourceId: "second_list",
        enabled: true,
        bounds: { left: 0, top: 100, right: 100, bottom: 200 },
        children: [{
          id: "second-item",
          text: "Item",
          enabled: true,
          bounds: { left: 0, top: 100, right: 100, bottom: 140 },
          children: []
        }]
      }
    ];

    const target = listLocatableTargets(roots).find(
      ({ element }) => element.id === "second-item"
    );
    expect(target?.locator).toEqual({
      text: "Item",
      within: { resourceId: "second_list" }
    });
  });
});
