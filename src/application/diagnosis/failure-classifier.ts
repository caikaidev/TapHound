import {
  FAILURE_CODE_TYPES,
  FAILURE_TYPE_STAGES,
  FailureClassificationSchema,
  type FailureClassification,
  type FailureType
} from "../../domain/failure-classification.js";
import type { TapHoundReport } from "../../domain/report.js";
import type { Locator } from "../../domain/layout.js";

export interface FailureClassifierInput {
  report: TapHoundReport;
  classificationId?: string | undefined;
}

export interface FailureClassifierDependencies {
  now: () => Date;
}

function expectedActualFor(
  type: FailureType,
  report: TapHoundReport
): { expected?: string; actual?: string } {
  const primary = report.primaryFailure;
  if (primary === undefined) {
    return {};
  }
  if (type === "activity_mismatch") {
    const step = report.steps.find((candidate) => (
      candidate.status === "failed"
    ));
    const check = step?.activity?.after.status === "failed"
      ? step.activity.after
      : step?.activity?.before.status === "failed"
        ? step.activity.before
        : undefined;
    if (check !== undefined) {
      return {
        expected: check.expected,
        actual: check.actual ?? "missing"
      };
    }
  }
  if (type === "expect_failed") {
    const step = report.steps.find((candidate) => (
      candidate.expectation?.status === "failed"
    ));
    const expectation = step?.expectation;
    if (expectation !== undefined) {
      return {
        expected: expectation.type,
        actual: expectation.message ?? "missing"
      };
    }
  }
  if (
    type === "target_not_found"
    || type === "target_ambiguous"
    || type === "target_unresolved"
  ) {
    const step = report.steps.find((candidate) => (
      candidate.status === "failed"
    ));
    const locator = step?.locator;
    if (locator !== undefined) {
      const source = locator.anchorId ?? locator.message ?? locator.matchedBy;
      if (source === undefined) {
        return {};
      }
      return {
        expected: locator.status === "found"
          ? `found ${source}`
          : source,
        actual: locator.status === "failed"
          ? "not found in layout"
          : locator.status
      };
    }
  }
  if (type === "app_crash") {
    return {
      expected: "process alive",
      actual: "process exited"
    };
  }
  if (type === "contract_invalid" || type === "evidence_failed") {
    return {
      expected: "binding satisfied",
      actual: primary.message
    };
  }
  return {};
}

function evidenceRefsFor(report: TapHoundReport): string[] {
  const refs: string[] = [];
  for (const screenshot of report.artifacts.screenshots) {
    refs.push(screenshot.path);
  }
  for (const logcat of report.artifacts.logcats) {
    refs.push(logcat.path);
  }
  for (const stepLog of report.artifacts.stepLogs) {
    refs.push(stepLog);
  }
  const failedStepLog = report.steps.find((step) => (
    step.status === "failed" && step.logcatPath !== undefined
  ));
  if (failedStepLog?.logcatPath !== undefined) {
    refs.push(failedStepLog.logcatPath);
  }
  return refs;
}

function locatorFor(
  type: FailureType,
  report: TapHoundReport
): Locator | undefined {
  if (
    type !== "target_not_found"
    && type !== "target_ambiguous"
    && type !== "target_unresolved"
  ) {
    return undefined;
  }
  const locator = report.steps.find((step) => step.status === "failed")?.locator;
  if (locator === undefined) {
    return undefined;
  }
  // Rebuild a canonical Locator from a report locator: report locators carry
  // runtime status fields the domain Locator does not accept.
  if (locator.anchorId !== undefined) {
    return { resourceId: `anchor:${locator.anchorId}` };
  }
  if (locator.matchedBy === "resourceId") {
    return { resourceId: locator.message ?? "resourceId" };
  }
  if (locator.matchedBy === "text") {
    return { text: locator.message ?? "text" };
  }
  if (locator.matchedBy === "contentDescription") {
    return { contentDescription: locator.message ?? "contentDescription" };
  }
  return { resourceId: "unknown" };
}

/**
 * Deterministic Failure Classifier (architecture doc §20, P1.5).
 *
 * Maps a completed run report into a concise, structured failure contract for
 * a Coding Agent: type, likely stage, expected vs actual, step index, locator,
 * and evidence refs. No model call, no log dump; raw evidence stays on disk
 * and is referenced by path. Classification is pure derivation from the
 * published report.
 */
export class FailureClassifier {
  public constructor(
    private readonly dependencies: FailureClassifierDependencies
  ) {}

  public readonly classify = (input: FailureClassifierInput): FailureClassification => {
    const { report } = input;
    const primary = report.primaryFailure;
    if (primary === undefined) {
      throw new Error(
        `Cannot classify run ${report.runId}: the report has no primary failure`
      );
    }
    const type = FAILURE_CODE_TYPES[primary.code] ?? "internal_error";
    const stage = FAILURE_TYPE_STAGES[type];
    const expectedActual = expectedActualFor(type, report);
    const locator = locatorFor(type, report);
    const classificationId = input.classificationId
      ?? `${report.runId}:${primary.code}:${String(primary.stepIndex ?? "-")}`;

    const classification = FailureClassificationSchema.parse({
      version: 1,
      runId: report.runId,
      classificationId,
      type,
      stage,
      code: primary.code,
      message: primary.message,
      ...(primary.stepIndex === undefined
        ? {}
        : { stepIndex: primary.stepIndex }),
      ...(expectedActual.expected === undefined
        ? {}
        : { expected: expectedActual.expected }),
      ...(expectedActual.actual === undefined
        ? {}
        : { actual: expectedActual.actual }),
      ...(locator === undefined ? {} : { locator }),
      evidenceRefs: evidenceRefsFor(report),
      sourceReportPath: report.artifacts.report
    });
    return classification;
  };
}