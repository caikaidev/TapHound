import { z } from "zod";

import { BoundsSchema, type LayoutElement } from "./layout.js";

export const AppWindowSchema = z.strictObject({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  packageName: z.string().trim().min(1),
  type: z.string().trim().min(1).optional(),
  layer: z.number().int().nonnegative().optional(),
  bounds: BoundsSchema.optional(),
  touchable: z.boolean(),
  focusable: z.boolean().optional(),
  focused: z.boolean().optional()
});

export type AppWindow = z.infer<typeof AppWindowSchema>;

export const WindowTopologySchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["observed", "unavailable"]),
  windows: z.array(AppWindowSchema),
  diagnostic: z.string().trim().min(1).optional()
}).superRefine((topology, context) => {
  if (
    topology.status === "observed"
    && topology.diagnostic !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["diagnostic"],
      message: "Observed window topology cannot include an unavailable diagnostic"
    });
  }
  if (topology.status === "unavailable" && topology.windows.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["windows"],
      message: "Unavailable window topology cannot include windows"
    });
  }
});

export type WindowTopology = z.infer<typeof WindowTopologySchema>;

const HierarchyDiagnosticSchema = z.strictObject({
  code: z.enum([
    "WINDOW_TOPOLOGY_UNAVAILABLE",
    "SEMANTIC_WINDOW_IDS_UNAVAILABLE",
    "APP_WINDOW_WITHOUT_SEMANTIC_ROOT",
    "APP_WINDOW_NOT_ACCESSIBILITY_READABLE"
  ]),
  message: z.string().trim().min(1)
});

export const WindowHierarchySchema = z.strictObject({
  status: z.enum(["complete", "incomplete", "unknown"]),
  appWindows: z.array(AppWindowSchema),
  semanticWindowIds: z.array(z.string().trim().min(1)),
  diagnostics: z.array(HierarchyDiagnosticSchema),
  recovery: z.array(z.enum([
    "REOBSERVE",
    "LAYOUT_INSPECTOR",
    "DEBUG_WINDOW_INSPECTOR"
  ]))
});

export type WindowHierarchy = z.infer<typeof WindowHierarchySchema>;

function windowIds(elements: readonly LayoutElement[]): string[] {
  return [...new Set(elements.flatMap((element) => [
    ...(element.windowId === undefined ? [] : [element.windowId]),
    ...windowIds(element.children)
  ]))].sort((left, right) => left.localeCompare(right));
}

function hasActionableElement(elements: readonly LayoutElement[]): boolean {
  return elements.some((element) => (
    (
      element.enabled
      && (
        element.clickable === true
        || element.longClickable === true
        || element.focusable === true
      )
    )
    || hasActionableElement(element.children)
  ));
}

/**
 * Android accessibility serializes the active (focused) window. A visible
 * touchable window that cannot take focus therefore never reaches the layout,
 * no matter which acquisition backend is used. Sub panels are excluded because
 * they carry decorations such as text-selection handles rather than controls.
 */
function unreadableWindows(
  windows: readonly AppWindow[]
): AppWindow[] {
  return windows.filter((window) => (
    window.focusable === false
    && window.type !== "BASE_APPLICATION"
    && window.type !== "APPLICATION_SUB_PANEL"
  ));
}

export function assessWindowHierarchy(
  topology: WindowTopology,
  layout: readonly LayoutElement[]
): WindowHierarchy {
  const parsedTopology = WindowTopologySchema.parse(topology);
  const semanticWindowIds = windowIds(layout);
  const unreadable = unreadableWindows(parsedTopology.windows);
  if (unreadable.length > 0) {
    return WindowHierarchySchema.parse({
      status: "incomplete",
      appWindows: parsedTopology.windows,
      semanticWindowIds,
      diagnostics: unreadable.map((window) => ({
        code: "APP_WINDOW_NOT_ACCESSIBILITY_READABLE",
        message: `Visible app window ${window.title}${
          window.type === undefined ? "" : ` (${window.type})`
        } cannot take focus, so accessibility never exposes its content`
      })),
      recovery: [
        "REOBSERVE",
        "LAYOUT_INSPECTOR",
        "DEBUG_WINDOW_INSPECTOR"
      ]
    });
  }
  if (parsedTopology.status === "unavailable") {
    return WindowHierarchySchema.parse({
      status: "unknown",
      appWindows: [],
      semanticWindowIds,
      diagnostics: [{
        code: "WINDOW_TOPOLOGY_UNAVAILABLE",
        message: parsedTopology.diagnostic
          ?? "ADB window topology is unavailable"
      }],
      recovery: ["REOBSERVE"]
    });
  }
  if (semanticWindowIds.length === 0) {
    return WindowHierarchySchema.parse({
      status: "unknown",
      appWindows: parsedTopology.windows,
      semanticWindowIds,
      diagnostics: [{
        code: "SEMANTIC_WINDOW_IDS_UNAVAILABLE",
        message: "Android layout did not expose semantic window identifiers"
      }],
      recovery: ["REOBSERVE"]
    });
  }
  if (parsedTopology.windows.length === 0) {
    return WindowHierarchySchema.parse({
      status: "unknown",
      appWindows: [],
      semanticWindowIds,
      diagnostics: [{
        code: "WINDOW_TOPOLOGY_UNAVAILABLE",
        message: "ADB window topology contained no visible touchable target-app windows"
      }],
      recovery: ["REOBSERVE"]
    });
  }
  if (parsedTopology.windows.length > semanticWindowIds.length) {
    const nonPanelWindows = parsedTopology.windows.filter(
      (window) => window.type !== "APPLICATION_PANEL"
    );
    if (
      parsedTopology.windows.some(
        (window) => window.type === "APPLICATION_PANEL"
      )
      && nonPanelWindows.length <= semanticWindowIds.length
      && hasActionableElement(layout)
    ) {
      return WindowHierarchySchema.parse({
        status: "complete",
        appWindows: parsedTopology.windows,
        semanticWindowIds,
        diagnostics: [],
        recovery: []
      });
    }
    return WindowHierarchySchema.parse({
      status: "incomplete",
      appWindows: parsedTopology.windows,
      semanticWindowIds,
      diagnostics: [{
        code: "APP_WINDOW_WITHOUT_SEMANTIC_ROOT",
        message: `ADB observed ${String(parsedTopology.windows.length)} visible touchable app windows, but Android layout exposed ${String(semanticWindowIds.length)} semantic window roots`
      }],
      recovery: [
        "REOBSERVE",
        "LAYOUT_INSPECTOR",
        "DEBUG_WINDOW_INSPECTOR"
      ]
    });
  }
  return WindowHierarchySchema.parse({
    status: "complete",
    appWindows: parsedTopology.windows,
    semanticWindowIds,
    diagnostics: [],
    recovery: []
  });
}
