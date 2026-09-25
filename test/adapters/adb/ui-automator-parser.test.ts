import { describe, expect, it } from "vitest";

import { parseUiAutomatorLayout } from "../../../src/adapters/adb/ui-automator-parser.js";

describe("parseUiAutomatorLayout", () => {
  it("normalizes View resource ids and preserves raw Compose test tags", () => {
    const layout = parseUiAutomatorLayout(
      '<hierarchy><node resource-id="com.example:id/root" bounds="[0,0][100,100]">' +
      '<node resource-id="compose_test_tag" text="" content-desc="" ' +
      'bounds="[10,10][90,40]" /></node></hierarchy>'
    );

    expect(layout[0]).toMatchObject({ resourceId: "root", enabled: true });
    expect(layout[0]?.children[0]).toMatchObject({
      resourceId: "compose_test_tag",
      enabled: true
    });
    expect(layout[0]?.children[0]?.text).toBeUndefined();
    expect(layout[0]?.children[0]?.contentDescription).toBeUndefined();
  });

  it("returns an empty layout for an empty hierarchy", () => {
    expect(parseUiAutomatorLayout("<hierarchy />")).toEqual([]);
  });

  it("rejects malformed bounds but preserves zero-area structure nodes", () => {
    expect(() => parseUiAutomatorLayout(
      '<hierarchy><node bounds="invalid" /></hierarchy>'
    )).toThrow("Invalid UIAutomator bounds");
    const layout = parseUiAutomatorLayout(
      '<hierarchy><node bounds="[0,0][0,0]" /></hierarchy>'
    );
    expect(layout).toEqual([{
      id: "ui-0",
      enabled: true,
      children: []
    }]);
  });

  it("preserves clickable ancestors for text nodes", () => {
    const layout = parseUiAutomatorLayout(
      '<hierarchy><node text="" resource-id="" bounds="[0,0][100,100]" enabled="true">' +
      '<node text="" resource-id="com.example:id/menu_item" clickable="true" ' +
      'focusable="true" bounds="[0,0][100,50]" enabled="true">' +
      '<node text="发起群聊" resource-id="com.example:id/tv_text" ' +
      'clickable="false" bounds="[10,10][90,40]" enabled="true" />' +
      "</node></node></hierarchy>"
    );

    expect(layout[0]?.children[0]?.children[0]).toMatchObject({
      text: "发起群聊",
      resourceId: "tv_text"
    });
    expect(layout[0]?.children[0]).toMatchObject({
      resourceId: "menu_item",
      clickable: true
    });
  });

  it("decodes numeric character references in multi-line text", () => {
    const layout = parseUiAutomatorLayout(
      '<hierarchy><node text="Line 1&#10;Line 2 &#x1F600; &amp;lt;" ' +
      'content-desc="a&#9;b" bounds="[0,0][100,100]" /></hierarchy>'
    );

    expect(layout[0]).toMatchObject({
      text: "Line 1\nLine 2 \u{1F600} &lt;",
      contentDescription: "a\tb"
    });
  });

  it("keeps an unescaped > inside a quoted attribute value", () => {
    const layout = parseUiAutomatorLayout(
      '<hierarchy><node text="a > b" bounds="[0,0][100,100]">' +
      "<node text='next>' bounds=\"[0,0][50,50]\" /></node></hierarchy>"
    );

    expect(layout[0]).toMatchObject({ text: "a > b" });
    expect(layout[0]?.children[0]).toMatchObject({ text: "next>" });
  });

  it("parses a deep hierarchy in document order with stable ids", () => {
    const depth = 40;
    const xml = "<hierarchy>"
      + Array.from({ length: depth }, (_, index) => (
        `<node resource-id="com.example:id/n${String(index)}" bounds="[0,0][10,10]">`
      )).join("")
      + "</node>".repeat(depth)
      + "</hierarchy>";

    let current = parseUiAutomatorLayout(xml)[0];
    for (let index = 0; index < depth; index += 1) {
      expect(current).toMatchObject({
        id: `ui-${String(index)}`,
        resourceId: `n${String(index)}`
      });
      current = current?.children[0];
    }
    expect(current).toBeUndefined();
  });
});
