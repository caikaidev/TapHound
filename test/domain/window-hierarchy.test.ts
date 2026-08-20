import { describe, expect, it } from "vitest";

import {
  assessWindowHierarchy
} from "../../src/domain/window-hierarchy.js";

const window = {
  id: "activity-window",
  title: "MainActivity",
  packageName: "com.example.app",
  touchable: true
};

const layout = [{
  id: "root",
  windowId: "serializer-window",
  enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 200 },
  children: []
}];

describe("assessWindowHierarchy", () => {
  it("marks one app window and one semantic window complete", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [window]
    }, layout)).toMatchObject({
      status: "complete",
      semanticWindowIds: ["serializer-window"],
      diagnostics: []
    });
  });

  it("marks extra visible app windows incomplete", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [
        window,
        { ...window, id: "popup-window", title: "PopupWindow" }
      ]
    }, layout)).toMatchObject({
      status: "incomplete",
      diagnostics: [{
        code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT"
      }],
      recovery: [
        "REOBSERVE",
        "LAYOUT_INSPECTOR",
        "DEBUG_WINDOW_INSPECTOR"
      ]
    });
  });

  it("accepts an application panel merged into the semantic layout", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [
        window,
        {
          ...window,
          id: "popup-window",
          title: "PopupWindow",
          type: "APPLICATION_PANEL"
        }
      ]
    }, [{
      id: "root",
      windowId: "serializer-window",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: [],
      clickable: true
    }])).toMatchObject({
      status: "complete",
      diagnostics: [],
      recovery: []
    });
  });

  it("finds actionable controls nested below a non-actionable root", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [
        window,
        {
          ...window,
          id: "popup-window",
          title: "PopupWindow",
          type: "APPLICATION_PANEL"
        }
      ]
    }, [{
      id: "root",
      windowId: "serializer-window",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: [{
        id: "nested-action",
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 0, right: 20, bottom: 20 },
        children: []
      }]
    }])).toMatchObject({
      status: "complete",
      diagnostics: []
    });
  });

  it("marks a visible app window that cannot take focus incomplete", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [
        { ...window, type: "BASE_APPLICATION", focusable: true },
        {
          ...window,
          id: "popup-window",
          title: "PopupWindow:df1fd59",
          type: "APPLICATION_PANEL",
          focusable: false
        }
      ]
    }, layout)).toMatchObject({
      status: "incomplete",
      diagnostics: [{
        code: "APP_WINDOW_NOT_ACCESSIBILITY_READABLE",
        message: "Visible app window PopupWindow:df1fd59 (APPLICATION_PANEL) cannot take focus, so accessibility never exposes its content"
      }],
      recovery: [
        "REOBSERVE",
        "LAYOUT_INSPECTOR",
        "DEBUG_WINDOW_INSPECTOR"
      ]
    });
  });

  it("ignores sub panel decorations and unknown focusability", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [{
        ...window,
        id: "handle-window",
        title: "PopupWindow:handle",
        type: "APPLICATION_SUB_PANEL",
        focusable: false
      }]
    }, layout)).toMatchObject({ status: "complete", diagnostics: [] });
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [{ ...window, type: "APPLICATION_PANEL" }]
    }, layout)).toMatchObject({ status: "complete", diagnostics: [] });
  });

  it("does not claim incompleteness when either signal is unavailable", () => {
    expect(assessWindowHierarchy({
      version: 1,
      status: "unavailable",
      windows: [],
      diagnostic: "permission denied"
    }, layout).status).toBe("unknown");
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: [window]
    }, [{
      id: "root",
      enabled: true,
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      children: []
    }]).status).toBe("unknown");
    expect(assessWindowHierarchy({
      version: 1,
      status: "observed",
      windows: []
    }, layout).status).toBe("unknown");
  });
});
