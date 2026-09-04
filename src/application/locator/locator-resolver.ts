import type { FailureCode } from "../../domain/failure.js";
import {
  LOCATOR_FIELDS,
  type LocatorField
} from "../../domain/locator.js";
import type {
  LayoutElement,
  Locator,
  LocatorMatch
} from "../../domain/layout.js";
import {
  locatorEvidenceMatches
} from "../../domain/locator-evidence.js";
import type { DisplayViewport, Point } from "../../domain/geometry.js";
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
  evidenceMismatch?: true | undefined;
}

export type LocatorResolution = LocatedTarget | LocatorFailure;

export interface LocatorResolutionOptions {
  requireEnabled?: boolean | undefined;
  requiredCapability?: "clickable" | "longClickable" | undefined;
  viewport?: DisplayViewport | undefined;
}

function center(element: LayoutElement): Point | undefined {
  if (element.center !== undefined) {
    return element.center;
  }
  const bounds = element.bounds;
  if (bounds === undefined) {
    return undefined;
  }
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2)
  };
}

function fieldValueMatches(
  elementValue: string | undefined,
  locatorValue: string,
  match: LocatorMatch | undefined
): boolean {
  if (elementValue === undefined) {
    return false;
  }
  if (match === "contains") {
    return elementValue.includes(locatorValue);
  }
  if (match === "startsWith") {
    return elementValue.startsWith(locatorValue);
  }
  return elementValue === locatorValue;
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
  const match = locator.match;

  for (const field of LOCATOR_FIELDS) {
    const value = locator[field];
    if (value === undefined) {
      continue;
    }

    if (candidates === undefined) {
      const matches = entries.filter(
        ({ element }) => fieldValueMatches(element[field], value, match)
      );
      if (matches.length === 0) {
        continue;
      }
      candidates = matches;
      matchedBy = field;
    } else if (candidates.length > 1) {
      const narrowed = candidates.filter(
        ({ element }) => fieldValueMatches(element[field], value, match)
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
    locator.evidence !== undefined
    && !locatorEvidenceMatches(element, locator.evidence)
  ) {
    return {
      status: "failed",
      code: "LOCATOR_NOT_FOUND",
      message: "Indexed Locator element evidence does not match the live Layout",
      evidenceMismatch: true
    };
  }
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
  const point = center(element);
  if (point === undefined) {
    return {
      status: "failed",
      code: "ACTION_FAILED",
      message: `Layout element ${element.id} has no executable geometry`
    };
  }
  const viewport = options.viewport;
  if (
    viewport !== undefined
    && (
      point.x >= viewport.width
      || point.y >= viewport.height
      || (element.bounds !== undefined
        && (element.bounds.right > viewport.width
          || element.bounds.bottom > viewport.height))
    )
  ) {
    return {
      status: "failed",
      code: "ACTION_FAILED",
      message: `Layout element ${element.id} geometry is outside the physical display viewport`
    };
  }
  return {
    status: "found",
    element,
    point,
    matchedBy
  };
}
