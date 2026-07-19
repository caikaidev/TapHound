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

export function listRecorderTargets(
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
    return [{
      element,
      locator,
      label: targetLabel(element, locator)
    }];
  });
}
