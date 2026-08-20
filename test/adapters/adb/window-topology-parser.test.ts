import { describe, expect, it } from "vitest";

import {
  parseWindowTopology
} from "../../../src/adapters/adb/window-topology-parser.js";

function window(
  index: number,
  options: {
    id: string;
    title: string;
    packageName: string;
    type?: string;
    flags?: string;
    visible?: boolean;
    ready?: boolean;
    surface?: boolean;
    bounds?: string;
    layer?: number;
  }
): string {
  return [
    `  Window #${String(index)} Window{${options.id} u0 ${options.title}}:`,
    `    mOwnerUid=10371 package=${options.packageName} appop=NONE`,
    `    mAttrs={(0,0)(fillxfill) ty=${options.type ?? "APPLICATION_PANEL"}`,
    `      fl=${options.flags ?? "HARDWARE_ACCELERATED"}}`,
    `    mBaseLayer=${String(options.layer ?? 21000)} mSubLayer=0`,
    `    mHasSurface=${String(options.surface ?? true)} isReadyForDisplay()=${String(options.ready ?? true)}`,
    `    Frames: parent=[0,0][1200,2670] display=[0,0][1200,2670] frame=${options.bounds ?? "[0,0][1200,2670]"} last=[0,0][1200,2670]`,
    "    isOnScreen=true",
    `    isVisible=${String(options.visible ?? true)}`
  ].join("\n");
}

describe("parseWindowTopology", () => {
  it("keeps visible touchable target-app windows and stable diagnostics", () => {
    const output = [
      "mCurrentFocus=Window{popup-1 u0 PopupWindow:123}",
      window(0, {
        id: "popup-1",
        title: "PopupWindow:123",
        packageName: "com.example.app",
        layer: 23000,
        bounds: "[700,100][1160,500]"
      }),
      window(1, {
        id: "activity-1",
        title: "com.example.app/.MainActivity",
        packageName: "com.example.app",
        type: "BASE_APPLICATION"
      }),
      window(2, {
        id: "overlay-1",
        title: "NonTouchableOverlay",
        packageName: "com.example.app",
        flags: "NOT_TOUCHABLE HARDWARE_ACCELERATED"
      }),
      window(3, {
        id: "foreign-1",
        title: "StatusBar",
        packageName: "com.android.systemui"
      }),
      window(4, {
        id: "hidden-1",
        title: "OldActivity",
        packageName: "com.example.app",
        visible: false
      })
    ].join("\n");

    expect(parseWindowTopology(output, "com.example.app")).toEqual({
      version: 1,
      status: "observed",
      windows: [
        {
          id: "popup-1",
          title: "PopupWindow:123",
          packageName: "com.example.app",
          type: "APPLICATION_PANEL",
          layer: 23000,
          bounds: { left: 700, top: 100, right: 1160, bottom: 500 },
          touchable: true,
          focusable: true,
          focused: true
        },
        {
          id: "activity-1",
          title: "com.example.app/.MainActivity",
          packageName: "com.example.app",
          type: "BASE_APPLICATION",
          layer: 21000,
          bounds: { left: 0, top: 0, right: 1200, bottom: 2670 },
          touchable: true,
          focusable: true,
          focused: false
        }
      ]
    });
  });

  it("reports a window that cannot take focus as not focusable", () => {
    const output = window(0, {
      id: "popup-1",
      title: "PopupWindow:123",
      packageName: "com.example.app",
      flags: "NOT_FOCUSABLE WATCH_OUTSIDE_TOUCH HARDWARE_ACCELERATED"
    });

    expect(parseWindowTopology(output, "com.example.app").windows).toMatchObject([
      { id: "popup-1", touchable: true, focusable: false }
    ]);
  });
});
