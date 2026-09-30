import type { DisplayViewport } from "../../domain/geometry.js";
import type { TouchPolicy } from "../../domain/journey.js";
import type { LayoutElement, Locator } from "../../domain/layout.js";
import {
  resolveLocator,
  type LocatedTarget,
  type LocatorFailure
} from "../locator/locator-resolver.js";
import type { ActionTarget } from "./action-executor.js";

export type TargetedAction = "click" | "longClick" | "swipe";

export type ActionTargetResolution =
  | { status: "found"; target: ActionTarget; located: LocatedTarget }
  | LocatorFailure;

/**
 * The element an action acts on, with the capability semantics Generation,
 * generated Replay, and External Flow steps share: a click or longClick
 * reaches the nearest ancestor with that capability (touching the matched
 * element itself), and a swipe needs a scrollable element with bounds.
 * Under `touchPolicy: "element"` a click or longClick instead touches the
 * visible part of the enabled matched element without a capability check.
 */
export function resolveActionTarget(
  layout: readonly LayoutElement[],
  action: TargetedAction,
  locator: Locator,
  viewport: DisplayViewport | undefined,
  touchPolicy?: TouchPolicy
): ActionTargetResolution {
  const visibleElement = touchPolicy === "element" && action !== "swipe";
  const located = resolveLocator(layout, locator, {
    viewport,
    ...(action === "swipe" || visibleElement ? {} : {
      requiredCapability: action === "click" ? "clickable" : "longClickable"
    }),
    ...(visibleElement ? { visibleElement } : {})
  });
  if (located.status !== "found") {
    return located;
  }
  const element = located.element;
  if (visibleElement) {
    return {
      status: "found",
      located,
      target: {
        point: located.point,
        ...(element.bounds === undefined ? {} : { bounds: element.bounds })
      }
    };
  }
  if (action === "click" && element.clickable !== true) {
    return actionFailure("click target is not clickable");
  }
  if (action === "longClick" && element.longClickable !== true) {
    return actionFailure("longClick target is not longClickable");
  }
  if (
    action === "swipe"
    && (element.scrollable !== true || element.bounds === undefined)
  ) {
    return actionFailure("swipe target lacks scrollable bounds");
  }
  return {
    status: "found",
    located,
    target: {
      point: located.point,
      ...(element.bounds === undefined ? {} : { bounds: element.bounds })
    }
  };
}

function actionFailure(message: string): LocatorFailure {
  return { status: "failed", code: "ACTION_FAILED", message };
}
