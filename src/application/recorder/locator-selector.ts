import { LOCATOR_FIELDS } from "../../domain/locator.js";
import type {
  LayoutElement,
  Locator
} from "../../domain/layout.js";
import {
  locatorEvidenceForElement
} from "../../domain/locator-evidence.js";
import {
  flattenLayout,
  type LayoutEntry
} from "../locator/layout-traversal.js";

export interface RecorderTarget {
  element: LayoutElement;
  locator: Locator;
  label: string;
}

export type RecorderTargetAction = "click" | "longClick" | "swipe";

function selectLocatorInScope(
  target: LayoutElement,
  elements: readonly LayoutElement[]
): Locator | undefined {
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

  let candidates = [...elements];
  let locator: Locator = {};
  for (const field of LOCATOR_FIELDS) {
    const value = target[field];
    if (value === undefined || value.length === 0) {
      continue;
    }
    candidates = candidates.filter((element) => element[field] === value);
    locator = { ...locator, [field]: value };
    if (candidates.length === 1) {
      return locator;
    }
  }

  const index = candidates.findIndex((element) => element === target);
  return index < 0 || LOCATOR_FIELDS.every((field) => locator[field] === undefined)
    ? undefined
    : {
        ...locator,
        index,
        evidence: locatorEvidenceForElement(target)
      };
}

export function selectUniqueLocator(
  target: LayoutElement,
  roots: readonly LayoutElement[]
): Locator | undefined {
  return selectLocator(target, flattenLayout(roots));
}

function selectLocator(
  target: LayoutElement,
  entries: readonly LayoutEntry[]
): Locator | undefined {
  const elements = entries.map(({ element }) => element);
  const global = selectLocatorInScope(target, elements);
  if (global === undefined || global.index === undefined) {
    return global;
  }

  const targetEntry = entries.find(({ element }) => element === target);
  for (const ancestor of [...(targetEntry?.ancestors ?? [])].reverse()) {
    const within = selectLocatorInScope(ancestor, elements);
    if (within === undefined) {
      continue;
    }
    const descendants = entries.filter(
      ({ ancestors }) => ancestors.includes(ancestor)
    ).map(({ element }) => element);
    const scoped = selectLocatorInScope(target, descendants);
    if (scoped !== undefined && scoped.index === undefined) {
      return { ...scoped, within };
    }
  }
  return global;
}

function targetLabel(element: LayoutElement, locator: Locator): string {
  const identity = LOCATOR_FIELDS.find(
    (field) => locator[field] !== undefined
  );
  if (identity === undefined) {
    return element.id;
  }
  const value = locator[identity] ?? element.id;
  const index = locator.index === undefined
    ? ""
    : ` [${String(locator.index)}]`;
  const scope = locator.within === undefined
    ? ""
    : " within scoped container";
  return `${element.id} — ${identity}: ${value}${index}${scope}`;
}

function supportsAction(
  element: LayoutElement,
  action: RecorderTargetAction
): boolean {
  const hasGeometry = element.center !== undefined
    || element.bounds !== undefined;
  if (!hasGeometry) return false;
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
  const entries = flattenLayout(roots);
  const locators = new Map(entries.map(({ element }) => [
    element,
    selectLocator(element, entries)
  ]));
  const primary = entries.flatMap(({ element }) => {
    if (!element.enabled || !supportsAction(element, action)) {
      return [];
    }
    const locator = locators.get(element);
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

  const hasOrphan = entries.some(
    ({ element }) => element.enabled
      && supportsAction(element, action)
      && locators.get(element) === undefined
  );
  if (!hasOrphan) {
    return primary;
  }

  const primaryIds = new Set(primary.map((target) => target.element.id));
  const relaxed = listLocatableTargetsFromEntries(entries, locators).filter(
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
  const entries = flattenLayout(roots);
  const locators = new Map(entries.map(({ element }) => [
    element,
    selectLocator(element, entries)
  ]));
  return listLocatableTargetsFromEntries(entries, locators);
}

function listLocatableTargetsFromEntries(
  entries: readonly LayoutEntry[],
  locators: ReadonlyMap<LayoutElement, Locator | undefined>
): RecorderTarget[] {
  return entries.flatMap(({ element }) => {
    if (!element.enabled) {
      return [];
    }
    const locator = locators.get(element);
    if (locator === undefined) {
      return [];
    }
    return [{ element, locator, label: targetLabel(element, locator) }];
  });
}
