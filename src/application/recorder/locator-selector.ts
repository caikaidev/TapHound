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

type LocatorIdentityField = (typeof LOCATOR_FIELDS)[number];

/**
 * Document-order index over one flattened layout. Pre-order traversal places
 * every subtree in a contiguous position range, so scoped uniqueness checks
 * become range queries over per-value position lists instead of O(n) scans
 * repeated for every element (which made target listing O(n^2 x depth)).
 */
interface LocatorIndex {
  entries: readonly LayoutEntry[];
  positions: ReadonlyMap<LayoutElement, number>;
  subtreeEnd: readonly number[];
  byField: Readonly<Record<LocatorIdentityField, Map<string, number[]>>>;
  globalLocators: Map<LayoutElement, Locator | undefined>;
}

interface Scope {
  start: number;
  end: number;
}

function buildLocatorIndex(entries: readonly LayoutEntry[]): LocatorIndex {
  const positions = new Map<LayoutElement, number>();
  const subtreeEnd = new Array<number>(entries.length).fill(entries.length);
  const byField = {
    resourceId: new Map<string, number[]>(),
    text: new Map<string, number[]>(),
    contentDescription: new Map<string, number[]>()
  };
  const open: number[] = [];
  for (const [position, { element, ancestors }] of entries.entries()) {
    if (!positions.has(element)) positions.set(element, position);
    while (open.length > ancestors.length) {
      const closed = open.pop();
      if (closed !== undefined) subtreeEnd[closed] = position;
    }
    open.push(position);
    for (const field of LOCATOR_FIELDS) {
      const value = element[field];
      if (value === undefined || value.length === 0) continue;
      const list = byField[field].get(value);
      if (list === undefined) byField[field].set(value, [position]);
      else list.push(position);
    }
  }
  return {
    entries,
    positions,
    subtreeEnd,
    byField,
    globalLocators: new Map()
  };
}

function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? Infinity) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function positionsInScope(
  sorted: readonly number[],
  scope: Scope
): readonly number[] {
  return sorted.slice(
    lowerBound(sorted, scope.start),
    lowerBound(sorted, scope.end)
  );
}

function selectLocatorInScope(
  target: LayoutElement,
  index: LocatorIndex,
  scope: Scope
): Locator | undefined {
  for (const field of LOCATOR_FIELDS) {
    const value = target[field];
    if (
      value !== undefined
      && value.length > 0
      && positionsInScope(index.byField[field].get(value) ?? [], scope)
        .length === 1
    ) {
      return { [field]: value };
    }
  }

  let candidates: readonly number[] | undefined;
  let locator: Locator = {};
  for (const field of LOCATOR_FIELDS) {
    const value = target[field];
    if (value === undefined || value.length === 0) {
      continue;
    }
    candidates = candidates === undefined
      ? positionsInScope(index.byField[field].get(value) ?? [], scope)
      : candidates.filter(
          (position) => index.entries[position]?.element[field] === value
        );
    locator = { ...locator, [field]: value };
    if (candidates.length === 1) {
      return locator;
    }
  }

  if (candidates === undefined) {
    return undefined;
  }
  const position = candidates.findIndex(
    (candidate) => index.entries[candidate]?.element === target
  );
  return position < 0
    ? undefined
    : {
        ...locator,
        index: position,
        evidence: locatorEvidenceForElement(target)
      };
}

function globalLocator(
  target: LayoutElement,
  index: LocatorIndex
): Locator | undefined {
  if (index.globalLocators.has(target)) {
    return index.globalLocators.get(target);
  }
  const locator = selectLocatorInScope(
    target,
    index,
    { start: 0, end: index.entries.length }
  );
  index.globalLocators.set(target, locator);
  return locator;
}

export function selectUniqueLocator(
  target: LayoutElement,
  roots: readonly LayoutElement[]
): Locator | undefined {
  return selectLocator(target, buildLocatorIndex(flattenLayout(roots)));
}

function selectLocator(
  target: LayoutElement,
  index: LocatorIndex
): Locator | undefined {
  const global = globalLocator(target, index);
  if (global === undefined || global.index === undefined) {
    return global === undefined ? undefined : { ...global };
  }

  const targetPosition = index.positions.get(target);
  const ancestors = targetPosition === undefined
    ? []
    : index.entries[targetPosition]?.ancestors ?? [];
  for (const ancestor of [...ancestors].reverse()) {
    const within = globalLocator(ancestor, index);
    const ancestorPosition = index.positions.get(ancestor);
    if (within === undefined || ancestorPosition === undefined) {
      continue;
    }
    const scoped = selectLocatorInScope(target, index, {
      start: ancestorPosition + 1,
      end: index.subtreeEnd[ancestorPosition] ?? ancestorPosition + 1
    });
    if (scoped !== undefined && scoped.index === undefined) {
      return { ...scoped, within };
    }
  }
  return { ...global };
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
  const index = buildLocatorIndex(entries);
  const locators = new Map(entries.map(({ element }) => [
    element,
    selectLocator(element, index)
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
  const index = buildLocatorIndex(entries);
  const locators = new Map(entries.map(({ element }) => [
    element,
    selectLocator(element, index)
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
