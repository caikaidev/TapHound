import type { FalseDoneRunResult } from "../../domain/false-done.js";

export interface MetricPair {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

export interface FalseDoneCompareResult {
  baselineRunId: string;
  candidateRunId: string;
  caseDeltas: {
    caseId: string;
    baselineDetection: string;
    candidateDetection: string;
    changed: boolean;
  }[];
  metrics: {
    falseDoneRecall: MetricPair;
    falseRejectRate: MetricPair;
    verdictAgreementRate: MetricPair;
    replayStabilityRate: MetricPair;
    errorCount: MetricPair;
    anchorUnresolvedTotal: MetricPair;
    evidenceInsufficientTotal: MetricPair;
  };
}

export const FALSE_DONE_METRIC_KEYS = [
  "falseDoneRecall",
  "falseRejectRate",
  "verdictAgreementRate",
  "replayStabilityRate",
  "errorCount",
  "anchorUnresolvedTotal",
  "evidenceInsufficientTotal"
] as const;

export function compareFalseDoneRuns(
  baseline: FalseDoneRunResult,
  candidate: FalseDoneRunResult
): FalseDoneCompareResult {
  const pair = (
    baselineValue: number | null,
    candidateValue: number | null
  ): MetricPair => ({
    baseline: baselineValue,
    candidate: candidateValue,
    delta: baselineValue === null || candidateValue === null
      ? null
      : candidateValue - baselineValue
  });
  const baselineByCase = new Map(
    baseline.results.map((result) => [result.caseId, result])
  );
  const candidateByCase = new Map(
    candidate.results.map((result) => [result.caseId, result])
  );
  const caseIds = [...new Set([
    ...baselineByCase.keys(),
    ...candidateByCase.keys()
  ])].sort();
  const caseDeltas = caseIds.map((caseId) => {
    const before = baselineByCase.get(caseId);
    const after = candidateByCase.get(caseId);
    const baselineDetection = before?.detection ?? "error";
    const candidateDetection = after?.detection ?? "error";
    return {
      caseId,
      baselineDetection,
      candidateDetection,
      changed: baselineDetection !== candidateDetection
    };
  });
  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    caseDeltas,
    metrics: {
      falseDoneRecall: pair(
        baseline.metrics.falseDoneRecall,
        candidate.metrics.falseDoneRecall
      ),
      falseRejectRate: pair(
        baseline.metrics.falseRejectRate,
        candidate.metrics.falseRejectRate
      ),
      verdictAgreementRate: pair(
        baseline.metrics.verdictAgreementRate,
        candidate.metrics.verdictAgreementRate
      ),
      replayStabilityRate: pair(
        baseline.metrics.replayStabilityRate,
        candidate.metrics.replayStabilityRate
      ),
      errorCount: pair(
        baseline.metrics.errorCount,
        candidate.metrics.errorCount
      ),
      anchorUnresolvedTotal: pair(
        baseline.metrics.anchorUnresolvedTotal,
        candidate.metrics.anchorUnresolvedTotal
      ),
      evidenceInsufficientTotal: pair(
        baseline.metrics.evidenceInsufficientTotal,
        candidate.metrics.evidenceInsufficientTotal
      )
    }
  };
}