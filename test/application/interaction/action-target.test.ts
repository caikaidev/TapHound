import { describe, expect, it } from "vitest";

import { resolveActionTarget } from "../../../src/application/interaction/action-target.js";
import type { LayoutElement } from "../../../src/domain/layout.js";

function element(overrides: Partial<LayoutElement> = {}): LayoutElement {
  return {
    id: "element",
    enabled: true,
    bounds: { left: 0, top: 0, right: 200, bottom: 100 },
    children: [],
    ...overrides
  };
}

describe("resolveActionTarget", () => {
  it("clicks a label through its clickable row at the label's point", () => {
    const row = element({
      id: "row",
      clickable: true,
      bounds: { left: 0, top: 0, right: 1000, bottom: 200 },
      children: [element({
        id: "label",
        text: "Settings",
        bounds: { left: 40, top: 50, right: 340, bottom: 150 }
      })]
    });

    expect(resolveActionTarget([row], "click", { text: "Settings" }, undefined))
      .toMatchObject({
        status: "found",
        located: { element: { id: "row" } },
        target: {
          point: { x: 190, y: 100 },
          bounds: { left: 0, top: 0, right: 1000, bottom: 200 }
        }
      });
  });

  it("fails closed when nothing handles the click", () => {
    expect(resolveActionTarget(
      [element({ resourceId: "title" })],
      "click",
      { resourceId: "title" },
      undefined
    )).toMatchObject({ status: "failed", code: "ACTION_FAILED" });
  });

  it("requires longClickable for longClick", () => {
    expect(resolveActionTarget(
      [element({ resourceId: "item", clickable: true })],
      "longClick",
      { resourceId: "item" },
      undefined
    )).toMatchObject({ status: "failed", code: "ACTION_FAILED" });
  });

  it("requires scrollable bounds for swipe", () => {
    expect(resolveActionTarget(
      [element({ resourceId: "list" })],
      "swipe",
      { resourceId: "list" },
      undefined
    )).toEqual({
      status: "failed",
      code: "ACTION_FAILED",
      message: "swipe target lacks scrollable bounds"
    });
    expect(resolveActionTarget(
      [element({ resourceId: "list", scrollable: true })],
      "swipe",
      { resourceId: "list" },
      undefined
    )).toMatchObject({ status: "found" });
  });

  it("keeps Locator failures as Locator failures", () => {
    expect(resolveActionTarget([], "click", { resourceId: "gone" }, undefined))
      .toMatchObject({ status: "failed", code: "LOCATOR_NOT_FOUND" });
  });
});
