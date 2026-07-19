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

export interface LocatorResolutionOptions {
  requireEnabled?: boolean | undefined;
}

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
}

function center(element: LayoutElement): Point {
  if (element.center !== undefined) {
    return element.center;
  }
  const bounds = element.bounds;
  if (bounds === undefined) {
    throw new Error(`Layout element ${element.id} has no center or bounds`);
  }
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2)
  };
}

export function resolveLocator(
  roots: readonly LayoutElement[],
  locator: Locator,
  options: LocatorResolutionOptions = {}
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
  if (options.requireEnabled !== false && !element.enabled) {
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
