import { LOCATOR_FIELDS } from "../../domain/locator.js";
import type {
  LayoutElement,
  Locator
} from "../../domain/layout.js";

export interface RecorderTarget {
  element: LayoutElement;
  locator: Locator;
  label: string;
}

export type RecorderTargetAction = "click" | "longClick" | "swipe";

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
}

export function selectUniqueLocator(
  target: LayoutElement,
  roots: readonly LayoutElement[]
): Locator | undefined {
  const elements = flatten(roots);
  for (const field of LOCATOR_FIELDS) {
    const value = target[field];
    if (
      value !== undefined
      && value.length > 0
      && elements.filter((element) => element[field] === value).length === 1
    ) {
      return { [field]: value };
    }
  }
  return undefined;
}

function targetLabel(element: LayoutElement, locator: Locator): string {
  const identity = LOCATOR_FIELDS.find(
    (field) => locator[field] !== undefined
  );
  if (identity === undefined) {
    return element.id;
  }
  const value = locator[identity] ?? element.id;
  return `${element.id} — ${identity}: ${value}`;
}

function supportsAction(
  element: LayoutElement,
  action: RecorderTargetAction
): boolean {
  return action === "click"
    ? element.clickable === true
    : action === "longClick"
      ? element.longClickable === true
      : element.scrollable === true && element.bounds !== undefined;
}

export function listRecorderTargets(
  roots: readonly LayoutElement[],
  action: RecorderTargetAction
): RecorderTarget[] {
  const primary = flatten(roots).flatMap((element) => {
    if (!element.enabled || !supportsAction(element, action)) {
      return [];
    }
    const locator = selectUniqueLocator(element, roots);
    if (locator === undefined) {
      return [];
    }
    return [{
      element,
      locator,
      label: targetLabel(element, locator)
    }];
  });

  // Relaxed content targets are click-only: for longClick the interactive
  // target is often a small bounded view (e.g. a chat bubble), so a sibling
  // label's center coordinate hit-tests to a neighbouring element instead.
  if (action !== "click") {
    return primary;
  }

  const hasOrphan = flatten(roots).some(
    (element) => element.enabled
      && supportsAction(element, action)
      && selectUniqueLocator(element, roots) === undefined
  );
  if (!hasOrphan) {
    return primary;
  }

  const primaryIds = new Set(primary.map((target) => target.element.id));
  const relaxed = listLocatableTargets(roots).filter(
    (target) => !supportsAction(target.element, action)
      && !primaryIds.has(target.element.id)
      && (target.locator.text !== undefined
        || target.locator.contentDescription !== undefined)
  );

  return [...primary, ...relaxed];
}

export function listLocatableTargets(
  roots: readonly LayoutElement[]
): RecorderTarget[] {
  return flatten(roots).flatMap((element) => {
    if (!element.enabled) {
      return [];
    }
    const locator = selectUniqueLocator(element, roots);
    if (locator === undefined) {
      return [];
    }
    return [{ element, locator, label: targetLabel(element, locator) }];
  });
}
