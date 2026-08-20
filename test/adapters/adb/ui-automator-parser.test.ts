import { describe, expect, it } from "vitest";

import { parseUiAutomatorLayout } from "../../../src/adapters/adb/ui-automator-parser.js";

describe("parseUiAutomatorLayout", () => {
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
