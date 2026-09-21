import type { TapHoundReport } from "../../domain/report.js";
import {
  BaselineSchema,
  type Baseline,
  type BaselineActivityFact,
  type BaselineCheckpointFact,
  type BaselineElementFact,
  type BaselineScreenFact
} from "../../domain/checkpoint.js";
import type { VerifyResult } from "../runtime/verify-runtime.js";
import { BaselineError } from "./baseline-error.js";

export interface BaselineCaptureInput {
  id: string;
  journeySha256: string;
  contractSha256?: string | undefined;
  includeScreenFacts?: boolean | undefined;
  capturedAt: string;
  runId: string;
  packageName: string;
  result: Pick<
    VerifyResult,
    "report" | "hookOutcomes" | "status" | "reportPath"
  >;
}

export interface BaselineCapturerDependencies {
  now: () => Date;
  createBaselineId?: (() => string) | undefined;
}

function activityFacts(report: TapHoundReport): BaselineActivityFact[] {
  const facts: BaselineActivityFact[] = [];
  for (const step of report.steps) {
    const before = step.activity?.before.actual;
    const after = step.activity?.after.actual;
    if (before === undefined || after === undefined) {
      continue;
    }
    facts.push({
      stepIndex: step.index,
      before,
      after
    });
  }
  return facts;
}

function elementFacts(report: TapHoundReport): BaselineElementFact[] {
  const facts: BaselineElementFact[] = [];
  const seen = new Set<string>();
  for (const step of report.steps) {
    const locator = step.locator;
    if (locator === undefined) {
      continue;
    }
    if (locator.status !== "found") {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Passed report has an unverified locator at step ${String(step.index)}`
      );
    }
    if (locator.anchorId === undefined && locator.requested === undefined) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Locator at step ${String(step.index)} has no stable identity`
      );
    }
    const identity = locator.anchorId === undefined
      ? { locator: locator.requested }
      : { anchorId: locator.anchorId };
    const key = JSON.stringify([step.index, identity]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    facts.push({
      ...identity,
      stepIndex: step.index,
      kind: "present",
      ...(locator.matchedBy === undefined
        ? {}
        : { matchedBy: locator.matchedBy }),
      fallbackUsed: locator.fallbackUsed
    });
  }
  return facts;
}

function screenFacts(
  report: TapHoundReport,
  hookOutcomes: VerifyResult["hookOutcomes"]
): BaselineScreenFact[] {
  const facts: BaselineScreenFact[] = [];
  for (const screen of report.screens ?? []) {
    facts.push(screen);
  }
  const afterOutcome = hookOutcomes?.find(
    (outcome) => (
      outcome.phase === "afterSteps"
      && outcome.status === "passed"
      && outcome.screen !== undefined
    )
  );
  if (afterOutcome?.screen === undefined) {
    return facts;
  }
  if (!facts.some((fact) => fact.screen === afterOutcome.screen)) {
    facts.push({
      screen: afterOutcome.screen,
      status: "matched"
    });
  }
  return facts;
}

function checkpointFacts(report: TapHoundReport): BaselineCheckpointFact[] {
  const facts: BaselineCheckpointFact[] = [];
  const seen = new Set<string>();
  for (const checkpoint of report.checkpoints ?? []) {
    if (checkpoint.status !== "passed" || seen.has(checkpoint.id)) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Checkpoint ${checkpoint.id} is not a unique passed result`
      );
    }
    seen.add(checkpoint.id);
    for (const condition of checkpoint.conditions) {
      if (condition.status !== "passed") {
        throw new BaselineError(
          "BASELINE_INCOMPARABLE",
          `Checkpoint ${checkpoint.id} has an unverified condition`
        );
      }
      const identity = {
        checkpointId: checkpoint.id,
        ...(checkpoint.stepIndex === undefined ? {} : { stepIndex: checkpoint.stepIndex })
      };
      switch (condition.kind) {
      case "activity":
      case "screen":
        facts.push({ ...identity, kind: condition.kind, expected: condition.expected });
        break;
      case "logcatEvent":
        if (report.logcatEvidence?.some((entry) => (
          entry.lastDroppedAtMs === undefined
            || entry.lastDroppedAtMs >= condition.startedAtMs
        )) === true
          || condition.matchedCount !== 1 || condition.matchedLineSha256 === undefined
          || condition.matchedAtMs === undefined
          || condition.evidenceRef === undefined) {
          throw new BaselineError(
            "BASELINE_INCOMPARABLE",
            `Checkpoint ${checkpoint.id} has incomplete Logcat event evidence`
          );
        }
        facts.push({ ...identity, kind: condition.kind, expect: condition.expect });
        break;
      default:
        facts.push({ ...identity, kind: condition.kind, locator: condition.locator });
      }
    }
  }
  return facts;
}

/**
 * Captures a Baseline from a completed (passing) verification run. The
 * capture is read-only with respect to the device: it derives deterministic
 * facts from the published report and hook outcomes.
 */
export class BaselineCapturer {
  public constructor(
    private readonly dependencies: BaselineCapturerDependencies
  ) {}

  public readonly capture = (input: BaselineCaptureInput): Baseline => {
    if (
      input.result.status !== "passed"
      || input.result.report.status !== "passed"
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Baseline capture requires a passed run; got ${input.result.status}`
      );
    }
    if (input.journeySha256 !== input.result.report.journey.sha256) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "Baseline Journey binding does not match the source report"
      );
    }
    if (
      input.runId !== input.result.report.runId
      || input.packageName !== input.result.report.project.packageName
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "Baseline run or package identity does not match the source report"
      );
    }
    const activities = activityFacts(input.result.report);
    const elements = elementFacts(input.result.report);
    const checkpoints = checkpointFacts(input.result.report);
    const screens = input.includeScreenFacts === false
      ? []
      : screenFacts(input.result.report, input.result.hookOutcomes);
    if (screens.some((screen) => screen.status !== "matched")) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "A Baseline can only freeze resolved Screen matches"
      );
    }
    if (activities.length + elements.length + screens.length + checkpoints.length === 0) {
      throw new BaselineError(
        "BASELINE_EMPTY",
        "Cannot capture a Baseline without comparable facts"
      );
    }
    const baseline = BaselineSchema.parse({
      version: 1,
      id: input.id,
      journeySha256: input.journeySha256,
      ...(input.contractSha256 === undefined
        ? {}
        : { contractSha256: input.contractSha256 }),
      capturedAt: input.capturedAt,
      packageName: input.packageName,
      runId: input.runId,
      activities,
      elements,
      screens,
      ...(checkpoints.length === 0 ? {} : { checkpoints }),
      requiredEvidence: { screens: screens.length > 0 },
      sourceReportPath: input.result.reportPath
    });
    return baseline;
  };
}