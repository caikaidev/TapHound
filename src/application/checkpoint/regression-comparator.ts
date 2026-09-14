import type {
  Baseline,
  RegressionCompareResult,
  RegressionDiff
} from "../../domain/checkpoint.js";
import { RegressionCompareResultSchema } from "../../domain/checkpoint.js";
import type { TapHoundReport } from "../../domain/report.js";

export interface RegressionCompareInput {
  baseline: Baseline;
  current: Pick<TapHoundReport, "steps" | "screens">;
  journeySha256: string;
  comparedAt: string;
}

function currentActivities(steps: TapHoundReport["steps"]): Map<number, {
  before: string | undefined;
  after: string | undefined;
}> {
  const map = new Map<number, {
    before: string | undefined;
    after: string | undefined;
  }>();
  for (const step of steps) {
    map.set(step.index, {
      before: step.activity?.before.actual,
      after: step.activity?.after.actual
    });
  }
  return map;
}

function currentElements(steps: TapHoundReport["steps"]): Set<string> {
  const set = new Set<string>();
  for (const step of steps) {
    const locator = step.locator;
    if (locator === undefined) {
      continue;
    }
    if (locator.status === "failed") {
      set.add(`absent:${reportLocatorKey(locator)}`);
    } else {
      set.add(`present:${reportLocatorKey(locator)}`);
    }
  }
  return set;
}

function reportLocatorKey(locator: {
  anchorId?: string | undefined;
  matchedBy?: string | undefined;
  requested?: {
    resourceId?: string | undefined;
    text?: string | undefined;
    contentDescription?: string | undefined;
  } | undefined;
  message?: string | undefined;
}): string {
  if (locator.anchorId !== undefined) {
    return `resourceId:anchor:${locator.anchorId}`;
  }
  if (locator.requested !== undefined) {
    return baselineLocatorKey(locator.requested);
  }
  const via = locator.matchedBy ?? "unknown";
  return `${via}:${via}`;
}

function baselineLocatorKey(locator: {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
}): string {
  if (locator.resourceId !== undefined) {
    return `resourceId:${locator.resourceId}`;
  }
  if (locator.text !== undefined) {
    return `text:${locator.text}`;
  }
  if (locator.contentDescription !== undefined) {
    return `contentDescription:${locator.contentDescription}`;
  }
  return "unknown";
}

/**
 * Deterministic Regression Comparator (architecture doc §16.1): is current
 * behavior still equivalent to the known-good Baseline?
 *
 * `equivalent: true` only when every baseline activity fact and element fact
 * is reproduced. A drift yields one `RegressionDiff` entry per fact with
 * `expected` (baseline) vs `actual` (current). This comparator is pure and
 * never calls a model; ambiguity is the job of the escalation policy.
 */
export const compareRegression = (
  input: RegressionCompareInput
): RegressionCompareResult => {
  const regressions: RegressionDiff[] = [];
  const currentActs = currentActivities(input.current.steps);
  for (const fact of input.baseline.activities) {
    const actual = currentActs.get(fact.stepIndex);
    if (actual === undefined) {
      regressions.push({
        kind: "activity",
        stepIndex: fact.stepIndex,
        expected: `before ${fact.before}`,
        actual: "missing"
      });
      continue;
    }
    if (actual.before !== fact.before) {
      regressions.push({
        kind: "activity",
        stepIndex: fact.stepIndex,
        expected: `before ${fact.before}`,
        actual: `before ${actual.before ?? "missing"}`
      });
    }
    if (actual.after !== fact.after) {
      regressions.push({
        kind: "activity",
        stepIndex: fact.stepIndex,
        expected: `after ${fact.after}`,
        actual: `after ${actual.after ?? "missing"}`
      });
    }
  }
  const currentEls = currentElements(input.current.steps);
  for (const fact of input.baseline.elements) {
    const key = `${fact.kind}:${baselineLocatorKey(fact.locator)}`;
    if (!currentEls.has(key)) {
      regressions.push({
        kind: "element",
        locator: fact.locator,
        expected: `${fact.kind} element`,
        actual: "missing"
      });
    }
  }
  const currentScreens = new Set(
    (input.current.screens ?? [])
      .map((screen) => screen.screen)
  );
  for (const fact of input.baseline.screens) {
    if (!currentScreens.has(fact.screen)) {
      regressions.push({
        kind: "screen",
        screen: fact.screen,
        expected: fact.status,
        actual: "missing"
      });
    }
  }
  const result = RegressionCompareResultSchema.parse({
    version: 1,
    baselineId: input.baseline.id,
    journeySha256: input.journeySha256,
    comparedAt: input.comparedAt,
    equivalent: regressions.length === 0,
    regressions
  });
  return result;
};