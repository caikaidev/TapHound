import type { FailureCode } from "../../domain/failure.js";
import {
  LOCATOR_FIELDS,
  type LocatorField
} from "../../domain/locator.js";
import type {
  LayoutElement,
  Locator
} from "../../domain/layout.js";
import type { Point } from "../../ports/android-cli.js";

export interface LocatedTarget {
  status: "found";
  element: LayoutElement;
  point: Point;
  matchedBy: LocatorField;
}

export interface LocatorFailure {
  status: "failed";
  code: Extract<
    FailureCode,
    "LOCATOR_NOT_FOUND" | "LOCATOR_AMBIGUOUS" | "ACTION_FAILED"
  >;
  message: string;
}

export type LocatorResolution = LocatedTarget | LocatorFailure;

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
}

function center(element: LayoutElement): Point {
  return {
    x: Math.round((element.bounds.left + element.bounds.right) / 2),
    y: Math.round((element.bounds.top + element.bounds.bottom) / 2)
  };
}

export function resolveLocator(
  roots: readonly LayoutElement[],
  locator: Locator
): LocatorResolution {
  const elements = flatten(roots);
  let candidates: LayoutElement[] | undefined;
  let matchedBy: LocatorField | undefined;

  for (const field of LOCATOR_FIELDS) {
    const value = locator[field];
    if (value === undefined) {
      continue;
    }

    if (candidates === undefined) {
      const matches = elements.filter((element) => element[field] === value);
      if (matches.length === 0) {
        continue;
      }
      candidates = matches;
      matchedBy = field;
    } else if (candidates.length > 1) {
      const narrowed = candidates.filter((element) => element[field] === value);
      if (narrowed.length === 0) {
        return {
          status: "failed",
          code: "LOCATOR_NOT_FOUND",
          message: `Locator fields conflict at ${field}`
        };
      }
      candidates = narrowed;
      matchedBy = field;
    }

    if (candidates.length === 1) {
      break;
    }
  }

  if (candidates === undefined || candidates.length === 0) {
    return {
      status: "failed",
      code: "LOCATOR_NOT_FOUND",
      message: "No Layout element matches the Locator"
    };
  }
  if (candidates.length > 1) {
    return {
      status: "failed",
      code: "LOCATOR_AMBIGUOUS",
      message: `Locator matches ${String(candidates.length)} Layout elements`
    };
  }

  const element = candidates[0];
  if (element === undefined || matchedBy === undefined) {
    return {
      status: "failed",
      code: "LOCATOR_NOT_FOUND",
      message: "No Layout element matches the Locator"
    };
  }
  if (!element.enabled) {
    return {
      status: "failed",
      code: "ACTION_FAILED",
      message: `Layout element ${element.id} is disabled`
    };
  }

  return {
    status: "found",
    element,
    point: center(element),
    matchedBy
  };
}
