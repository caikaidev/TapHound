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
import {
  flattenLayout,
  type LayoutEntry
} from "./layout-traversal.js";

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
  requiredCapability?: "clickable" | "longClickable" | undefined;
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

type EntryResolution = {
  status: "found";
  entry: LayoutEntry;
  matchedBy: LocatorField;
} | LocatorFailure;

function resolveEntry(
  allEntries: readonly LayoutEntry[],
  locator: Locator,
  entries: readonly LayoutEntry[] = allEntries
): EntryResolution {
  if (locator.within !== undefined) {
    const scope = resolveEntry(allEntries, locator.within);
    if (scope.status === "failed") {
      return {
        ...scope,
        message: `Locator scope failed: ${scope.message}`
      };
    }
    entries = allEntries.flatMap((entry) => {
      const scopeIndex = entry.ancestors.indexOf(scope.entry.element);
      return scopeIndex < 0
        ? []
        : [{
            ...entry,
            ancestors: entry.ancestors.slice(scopeIndex)
          }];
    });
  }
  let candidates: LayoutEntry[] | undefined;
  let matchedBy: LocatorField | undefined;

  for (const field of LOCATOR_FIELDS) {
    const value = locator[field];
    if (value === undefined) {
      continue;
    }

    if (candidates === undefined) {
      const matches = entries.filter(
        ({ element }) => element[field] === value
      );
      if (matches.length === 0) {
        continue;
      }
      candidates = matches;
      matchedBy = field;
    } else if (candidates.length > 1) {
      const narrowed = candidates.filter(
        ({ element }) => element[field] === value
      );
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
  if (locator.index !== undefined) {
    const indexed = candidates[locator.index];
    if (indexed === undefined) {
      return {
        status: "failed",
        code: "LOCATOR_NOT_FOUND",
        message: `Locator index ${String(locator.index)} is out of range for ${String(candidates.length)} matches`
      };
    }
    candidates = [indexed];
  } else if (candidates.length > 1) {
    return {
      status: "failed",
      code: "LOCATOR_AMBIGUOUS",
      message: `Locator matches ${String(candidates.length)} Layout elements`
    };
  }

  const entry = candidates[0];
  if (entry === undefined || matchedBy === undefined) {
    return {
      status: "failed",
      code: "LOCATOR_NOT_FOUND",
      message: "No Layout element matches the Locator"
    };
  }
  return { status: "found", entry, matchedBy };
}

export function resolveLocator(
  roots: readonly LayoutElement[],
  locator: Locator,
  options: LocatorResolutionOptions = {}
): LocatorResolution {
  const resolution = resolveEntry(flattenLayout(roots), locator);
  if (resolution.status === "failed") {
    return resolution;
  }
  const { entry, matchedBy } = resolution;
  let element = entry.element;
  if (
    options.requiredCapability !== undefined
    && element[options.requiredCapability] !== true
  ) {
    const ancestor = [...entry.ancestors].reverse().find(
      (candidate) => candidate.enabled
        && candidate[options.requiredCapability as "clickable" | "longClickable"]
          === true
    );
    if (ancestor === undefined) {
      return {
        status: "failed",
        code: "ACTION_FAILED",
        message: `Layout target lacks required ${options.requiredCapability} capability`
      };
    }
    element = ancestor;
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
