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
});
