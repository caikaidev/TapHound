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
import { summarizeLayoutElements } from "./layout-failure-summary.js";

export interface LocatedTarget {
  status: "found";
  element: LayoutElement;
  point: Point;
  matchedBy: LocatorField;
  matchedFields?: readonly LocatorField[] | undefined;
}

export interface LocatedIdentity {
  status: "found";
  element: LayoutElement;
  matchedBy: LocatorField;
  matchedFields?: readonly LocatorField[] | undefined;
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
export type LocatorIdentityResolution = LocatedIdentity | LocatorFailure;

export interface LocatorResolutionOptions {
  requireEnabled?: boolean | undefined;
  requiredCapability?: "clickable" | "longClickable" | undefined;
  viewport?: DisplayViewport | undefined;
}

function pointWithin(
  point: Point | undefined,
  bounds: LayoutElement["bounds"]
): Point | undefined {
  return point !== undefined
    && bounds !== undefined
    && point.x >= bounds.left
    && point.x < bounds.right
    && point.y >= bounds.top
    && point.y < bounds.bottom
    ? point
    : undefined;
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

const compiledPatterns = new Map<string, RegExp>();
const MAX_COMPILED_PATTERNS = 256;

/** Locator regexes are non-global, so a cached instance is stateless. */
function compiledPattern(pattern: string): RegExp {
  let compiled = compiledPatterns.get(pattern);
  if (compiled === undefined) {
    if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) {
      compiledPatterns.clear();
    }
    compiled = new RegExp(pattern);
    compiledPatterns.set(pattern, compiled);
  }
  return compiled;
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
  if (match === "regex") {
    return compiledPattern(locatorValue).test(elementValue);
  }
  return elementValue === locatorValue;
}

type EntryResolution = {
  status: "found";
  entry: LayoutEntry;
  matchedBy: LocatorField;
  matchedFields?: readonly LocatorField[] | undefined;
} | LocatorFailure;

function matchForField(
  locator: Locator,
  field: LocatorField
): LocatorMatch | undefined {
  return locator.matchBy?.[field] ?? locator.match;
}

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
  let matchedFields: LocatorField[] | undefined;

  if (locator.combine === "all") {
    matchedFields = LOCATOR_FIELDS.filter(
      (field) => locator[field] !== undefined
    );
    candidates = entries.filter(({ element }) => matchedFields?.every(
      (field) => fieldValueMatches(
        element[field],
        locator[field] as string,
        matchForField(locator, field)
      )
    ) === true);
    matchedBy = matchedFields[0];
  }

  for (const field of locator.combine === "all" ? [] : LOCATOR_FIELDS) {
    const value = locator[field];
    if (value === undefined) {
      continue;
    }

    if (candidates === undefined) {
      const matches = entries.filter(
        ({ element }) => fieldValueMatches(
          element[field],
          value,
          matchForField(locator, field)
        )
      );
      if (matches.length === 0) {
        continue;
      }
      candidates = matches;
      matchedBy = field;
    } else if (candidates.length > 1) {
      const narrowed = candidates.filter(
        ({ element }) => fieldValueMatches(
          element[field],
          value,
          matchForField(locator, field)
        )
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
      message: "No Layout element matches the Locator."
        + ` ${summarizeLayoutElements(allEntries.map((entry) => entry.element))}`
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
      message: "No Layout element matches the Locator."
        + ` ${summarizeLayoutElements(allEntries.map((entry) => entry.element))}`
    };
  }
  return {
    status: "found",
    entry,
    matchedBy,
    ...(matchedFields === undefined ? {} : { matchedFields })
  };
}

export function resolveLocatorIdentity(
  roots: readonly LayoutElement[],
  locator: Locator
): LocatorIdentityResolution {
  const resolution = resolveEntry(flattenLayout(roots), locator);
  if (resolution.status === "failed") {
    return resolution;
  }
  const { element } = resolution.entry;
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
  return {
    status: "found",
    element,
    matchedBy: resolution.matchedBy,
    ...(resolution.matchedFields === undefined
      ? {}
      : { matchedFields: resolution.matchedFields })
  };
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
    // The nearest capable ancestor receives the touch; a disabled one
    // swallows it, so it is reported instead of skipped.
    const ancestor = [...entry.ancestors].reverse().find(
      (candidate) => candidate[
        options.requiredCapability as "clickable" | "longClickable"
      ] === true
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
  // Touch the matched element itself: it dispatches to the capable ancestor,
  // whose own center may be covered by an unrelated child control.
  const point = element === entry.element
    ? center(element)
    : pointWithin(center(entry.element), element.bounds) ?? center(element);
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
    matchedBy,
    ...(resolution.matchedFields === undefined
      ? {}
      : { matchedFields: resolution.matchedFields })
  };
}
