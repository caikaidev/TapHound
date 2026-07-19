import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseLayout,
  parseLayoutDiff
} from "../../../src/adapters/android-cli/layout-parser.js";

const realLayoutFixture = fileURLToPath(
  new URL("../../fixtures/android-cli/layout-output.json", import.meta.url)
);

describe("parseLayout", () => {
  it("parses the flat ElementSerializer protocol from Android CLI 1.0", async () => {
    const elements = parseLayout(await readFile(realLayoutFixture, "utf8"));

    expect(elements).toEqual([
      {
        id: "123456",
        resourceId: "open_search",
        text: "Open search",
        contentDescription: "Open search screen",
        clickable: true,
        enabled: true,
        center: { x: 540, y: 1200 },
        children: []
      },
      {
        id: "234567",
        resourceId: "results",
        scrollable: true,
        enabled: true,
        center: { x: 540, y: 1400 },
        bounds: { left: 0, top: 200, right: 1080, bottom: 2200 },
        children: []
      }
    ]);
  });

  it("parses canonical Android CLI Layout JSON", () => {
    const elements = parseLayout(JSON.stringify({
      id: "root",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: [{
        id: "root/0",
        resourceId: "toolbar_search",
        text: "Search",
        contentDescription: "Open search",
        clickable: true,
        enabled: true,
        bounds: { left: 10, top: 20, right: 90, bottom: 60 },
        children: []
      }]
    }));

    expect(elements[0]?.children[0]).toMatchObject({
      resourceId: "toolbar_search",
      contentDescription: "Open search",
      clickable: true
    });
  });

  it("parses narrowly supported UI Automator aliases", () => {
    const elements = parseLayout(JSON.stringify({
      "resource-id": "toolbar_search",
      "content-desc": "Open search",
      clickable: "true",
      enabled: "true",
      bounds: "[10,20][90,60]",
      children: []
    }));

    expect(elements[0]).toMatchObject({
      id: "0",
      resourceId: "toolbar_search",
      contentDescription: "Open search",
      bounds: { left: 10, top: 20, right: 90, bottom: 60 }
    });
  });

  it("rejects malformed Layout JSON", () => {
    expect(() => parseLayout("{")).toThrow(/layout/i);
    expect(() => parseLayout(JSON.stringify({ enabled: true }))).toThrow(/layout/i);
  });
});

describe("parseLayoutDiff", () => {
  it("preserves nonempty diagnostic entries and recognizes an empty diff", () => {
    expect(parseLayoutDiff("[]")).toEqual([]);
    expect(parseLayoutDiff('[{"changed":"text"}]')).toEqual([
      { changed: "text" }
    ]);
  });
});
