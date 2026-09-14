import { createHash } from "node:crypto";

import type { TapHoundReport } from "../../domain/report.js";
import {
  BaselineSchema,
  type Baseline,
  type BaselineActivityFact,
  type BaselineElementFact,
  type BaselineScreenFact
} from "../../domain/checkpoint.js";
import type { VerifyResult } from "../runtime/verify-runtime.js";

export interface BaselineCaptureInput {
  id: string;
  journeySha256: string;
  contractSha256?: string | undefined;
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
    const key = JSON.stringify(locatorToKey(locator));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    facts.push({
      locator: locatorToKey(locator),
      kind: locator.status === "failed" ? "absent" : "present",
      ...(locator.matchedBy === undefined
        ? {}
        : { matchedBy: locator.matchedBy }),
      ...(locator.message === undefined
        ? {}
        : { evidenceSha256: hashText(locator.message) })
    });
  }
  return facts;
}

type ReportLocator = NonNullable<TapHoundReport["steps"][number]["locator"]>;

function locatorToKey(locator: ReportLocator): Baseline["elements"][number]["locator"] {
  if (locator.anchorId !== undefined) {
    return { resourceId: `anchor:${locator.anchorId}` };
  }
  if (locator.requested !== undefined) {
    return locator.requested;
  }
  const via = locator.matchedBy;
  if (via === "resourceId") {
    return { resourceId: "resourceId" };
  }
  if (via === "text") {
    return { text: "text" };
  }
  if (via === "contentDescription") {
    return { contentDescription: "contentDescription" };
  }
  return { resourceId: "unknown" };
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

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
    if (input.result.status !== "passed") {
      throw new Error(
        `Baseline capture requires a passed run; got ${input.result.status}`
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
      activities: activityFacts(input.result.report),
      elements: elementFacts(input.result.report),
      screens: screenFacts(input.result.report, input.result.hookOutcomes),
      sourceReportPath: input.result.reportPath
    });
    return baseline;
  };
}