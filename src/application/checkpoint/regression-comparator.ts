import type {
  Baseline,
  BaselineCheckpointFact,
  BaselineElementFact,
  RegressionCompareResult,
  RegressionDiff
} from "../../domain/checkpoint.js";
import {
  BaselineSchema,
  RegressionCompareResultSchema
} from "../../domain/checkpoint.js";
import type { TapHoundReport } from "../../domain/report.js";
import { BaselineError } from "./baseline-error.js";

export interface RegressionCompareInput {
  baseline: Baseline;
  current: Pick<TapHoundReport, "steps" | "screens" | "checkpoints" | "logcatEvidence">;
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

function elementIdentity(fact: Pick<
  BaselineElementFact,
  "locator" | "anchorId"
>): string {
  return fact.anchorId === undefined
    ? JSON.stringify(["locator", fact.locator])
    : JSON.stringify(["anchor", fact.anchorId]);
}

function conditionIdentity(
  fact: BaselineCheckpointFact
): string {
  return JSON.stringify([
    fact.kind,
    "locator" in fact ? fact.locator
      : "expect" in fact ? fact.expect : fact.expected
  ]);
}
function reportConditionIdentity(
  condition: NonNullable<TapHoundReport["checkpoints"]>[number]["conditions"][number]
): string {
  return JSON.stringify([
    condition.kind,
    "locator" in condition ? condition.locator
      : "expect" in condition ? condition.expect : condition.expected
  ]);
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
  BaselineSchema.parse(input.baseline);
  if (input.baseline.screens.some((fact) => fact.status !== "matched")) {
    throw new BaselineError(
      "BASELINE_INCOMPARABLE",
      "An unresolved Screen fact cannot establish equivalence"
    );
  }
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
  for (const fact of input.baseline.elements) {
    const stepIndex = fact.stepIndex;
    const current = input.current.steps.find(
      (step) => step.index === stepIndex
    )?.locator;
    if (current?.status === "found" && (
      current.anchorId === undefined
      && current.requested === undefined
    )) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Current locator at step ${String(stepIndex)} has no stable identity`
      );
    }
    if (
      current?.status !== "found"
      || elementIdentity({
        anchorId: current.anchorId,
        locator: current.requested
      }) !== elementIdentity(fact)
    ) {
      regressions.push({
        kind: "element",
        ...(fact.locator === undefined ? {} : { locator: fact.locator }),
        stepIndex,
        expected: `${fact.kind} element`,
        actual: current?.status === "found"
          ? "different element"
          : "missing"
      });
      continue;
    }
    if (fact.matchedBy !== undefined && current.matchedBy !== fact.matchedBy) {
      regressions.push({
        kind: "element",
        ...(fact.locator === undefined ? {} : { locator: fact.locator }),
        stepIndex,
        expected: `matched by ${fact.matchedBy}`,
        actual: `matched by ${current.matchedBy ?? "none"}`
      });
    }
    if (
      fact.fallbackUsed !== undefined
      && fact.fallbackUsed !== current.fallbackUsed
    ) {
      regressions.push({
        kind: "element",
        ...(fact.locator === undefined ? {} : { locator: fact.locator }),
        stepIndex,
        expected: `annotated fallback ${String(fact.fallbackUsed)}`,
        actual: `annotated fallback ${String(current.fallbackUsed)}`
      });
    }
  }
  const currentScreens = new Map(
    (input.current.screens ?? []).map((screen) => [
      screen.screen, screen.status
    ])
  );
  for (const fact of input.baseline.screens) {
    const currentStatus = currentScreens.get(fact.screen);
    if (currentStatus !== fact.status) {
      regressions.push({
        kind: "screen",
        screen: fact.screen,
        expected: fact.status,
        actual: currentStatus ?? "missing"
      });
    }
  }
  const checkpointFacts = input.baseline.checkpoints ?? [];
  const checkpointIds = new Set(checkpointFacts.map((fact) => fact.checkpointId));
  for (const id of checkpointIds) {
    const baselineConditions = checkpointFacts.filter((fact) => fact.checkpointId === id);
    const matches = (input.current.checkpoints ?? []).filter((entry) => entry.id === id);
    const checkpoint = matches[0];
    if (matches.length !== 1 || checkpoint === undefined) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Checkpoint ${id} has no unique current evaluation`
      );
    }
    if (
      checkpoint.stepIndex !== baselineConditions[0]?.stepIndex
      || checkpoint.conditions.length !== baselineConditions.length
      || checkpoint.conditions.some((condition) => !baselineConditions.some(
        (fact) => conditionIdentity(fact) === reportConditionIdentity(condition)
      ))
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Checkpoint ${id} does not have the same condition identities`
      );
    }
    for (const fact of baselineConditions) {
      const condition = checkpoint.conditions.find((entry) => (
        conditionIdentity(fact) === reportConditionIdentity(entry)
      ));
      if (condition?.status === "unresolved"
        || (condition?.kind === "logcatEvent" && condition.status === "passed"
          && (condition.matchedCount !== 1
            || condition.matchedLineSha256 === undefined
            || condition.matchedAtMs === undefined
            || condition.evidenceRef === undefined))
        || (fact.kind === "logcatEvent"
          && input.current.logcatEvidence?.some((entry) => (
            entry.lastDroppedAtMs === undefined
              || (condition?.kind === "logcatEvent"
                && entry.lastDroppedAtMs >= condition.startedAtMs)
          )) === true)) {
        throw new BaselineError(
          "BASELINE_INCOMPARABLE",
          `Checkpoint ${id} has unresolved current evidence`
        );
      }
      if (condition?.status !== "passed") {
        regressions.push({
          kind: fact.kind === "activity"
            ? "activity"
            : fact.kind === "screen" ? "screen"
              : fact.kind === "logcatEvent" ? "logcatEvent" : "element",
          checkpointId: id,
          ...(fact.stepIndex === undefined ? {} : { stepIndex: fact.stepIndex }),
          ...("locator" in fact ? { locator: fact.locator } : {}),
          ...(fact.kind === "screen" ? { screen: fact.expected } : {}),
          expected: `passed ${fact.kind}`,
          actual: condition?.status ?? "missing"
        });
      }
    }
  }
  const result = RegressionCompareResultSchema.parse({
    version: 1,
    baselineId: input.baseline.id,
    journeySha256: input.journeySha256,
    comparedAt: input.comparedAt,
    coverage: {
      activities: input.baseline.activities.length,
      elements: input.baseline.elements.length,
      screens: input.baseline.screens.length,
      ...(checkpointFacts.length === 0 ? {} : { checkpoints: checkpointFacts.length })
    },
    equivalent: regressions.length === 0,
    regressions
  });
  return result;
};