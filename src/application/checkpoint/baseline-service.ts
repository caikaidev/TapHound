import { dirname, join, resolve } from "node:path";

import type { Baseline, RegressionCompareResult } from "../../domain/checkpoint.js";
import { BaselineSchema, RegressionCompareResultSchema } from "../../domain/checkpoint.js";
import { ContractVerdictViewSchema } from "../../domain/contract.js";
import { TapHoundReportV4Schema, type TapHoundReport } from "../../domain/report.js";
import { BaselineError } from "./baseline-error.js";
import { BaselineCapturer } from "./baseline-capturer.js";
import { compareRegression } from "./regression-comparator.js";

export interface BaselineServiceDependencies {
  readText: (path: string) => Promise<string>;
  writeText: (path: string, content: string) => Promise<void>;
  now: () => Date;
}

export class BaselineService {
  private readonly capturer: BaselineCapturer;

  public constructor(
    private readonly dependencies: BaselineServiceDependencies
  ) {
    this.capturer = new BaselineCapturer({ now: dependencies.now });
  }

  public readonly captureFromReport = async (
    reportPath: string,
    input: {
      id?: string | undefined;
      journeySha256?: string | undefined;
      contractSha256?: string | undefined;
      verdictPath?: string | undefined;
      includeScreenFacts?: boolean | undefined;
    }
  ): Promise<Baseline> => {
    const report = await this.readReport(reportPath);
    if (report.status !== "passed") {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "Baseline capture requires a passed report"
      );
    }
    if (
      input.journeySha256 !== undefined
      && input.journeySha256 !== report.journey.sha256
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "Requested Journey hash differs from the report"
      );
    }
    const contractSha256 = input.contractSha256 === undefined
      && input.verdictPath === undefined
      ? undefined
      : await this.readPassingVerdict(
        input.verdictPath ?? join(dirname(reportPath), "verdict.json"),
        reportPath,
        report,
        input.contractSha256
      );
    const baseline = this.capturer.capture({
      id: input.id ?? report.runId,
      journeySha256: report.journey.sha256,
      ...(contractSha256 === undefined
        ? {}
        : { contractSha256 }),
      ...(input.includeScreenFacts === undefined
        ? {}
        : { includeScreenFacts: input.includeScreenFacts }),
      capturedAt: new Date(this.dependencies.now()).toISOString(),
      runId: report.runId,
      packageName: report.project.packageName,
      result: {
        report,
        hookOutcomes: [],
        status: "passed",
        reportPath
      }
    });
    return baseline;
  };

  public readonly write = async (input: {
    path: string;
    baseline: Baseline;
  }): Promise<void> => {
    await this.dependencies.writeText(
      input.path,
      `${JSON.stringify(input.baseline, null, 2)}\n`
    );
  };

  public readonly compare = async (input: {
    baselinePath: string;
    reportPath: string;
    journeySha256?: string | undefined;
    verdictPath?: string | undefined;
  }): Promise<RegressionCompareResult> => {
    const baseline = await this.readBaseline(input.baselinePath);
    const report = await this.readReport(input.reportPath);
    const checkpointFailure = report.status === "failed"
      && report.primaryFailure?.code === "CHECKPOINT_FAILED"
      && report.layers.run === "failed"
      && report.steps.every((step) => step.status === "passed")
      && report.checkpoints?.some((checkpoint) => checkpoint.status === "failed")
      && report.checkpoints.every((checkpoint) => checkpoint.status !== "unresolved")
      && (baseline.checkpoints?.length ?? 0) > 0
      && report.checkpoints.filter(
        (checkpoint) => checkpoint.status === "failed"
      ).every((checkpoint) => baseline.checkpoints?.some(
        (fact) => fact.checkpointId === checkpoint.id
      ))
      && baseline.activities.every((fact) => report.steps.some(
        (step) => step.index === fact.stepIndex && step.status === "passed"
      ))
      && baseline.elements.every((fact) => report.steps.some(
        (step) => step.index === fact.stepIndex && step.status === "passed"
      ));
    if (
      (report.status !== "passed" && !checkpointFailure)
      || report.journey.sha256 !== baseline.journeySha256
      || report.project.packageName !== baseline.packageName
      || (
        input.journeySha256 !== undefined
        && input.journeySha256 !== report.journey.sha256
      )
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Report identity or status does not match Baseline ${baseline.id}`
      );
    }
    if (
      (baseline.requiredEvidence?.screens ?? baseline.screens.length > 0)
      && (report.screens?.length ?? 0) === 0
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "The current report has no Screen evidence required by the Baseline"
      );
    }
    if (baseline.contractSha256 !== undefined) {
      await this.readPassingVerdict(
        input.verdictPath ?? join(dirname(input.reportPath), "verdict.json"),
        input.reportPath,
        report,
        baseline.contractSha256,
        checkpointFailure
      );
    }
    const result = compareRegression({
      baseline,
      current: report,
      journeySha256: report.journey.sha256,
      comparedAt: new Date(this.dependencies.now()).toISOString()
    });
    if (checkpointFailure && result.equivalent) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "A failed Checkpoint run cannot establish Baseline equivalence"
      );
    }
    return RegressionCompareResultSchema.parse(result);
  };

  private readonly readBaseline = async (path: string): Promise<Baseline> => {
    let value: unknown;
    try {
      value = JSON.parse(await this.dependencies.readText(path)) as unknown;
    } catch {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `Baseline is missing or not valid JSON: ${path}`
      );
    }
    const parsed = BaselineSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    if (
      parsed.error.issues.some((issue) => (
        issue.message === "A Baseline needs at least one comparable fact"
      ))
    ) {
      throw new BaselineError(
        "BASELINE_EMPTY",
        "Baseline contains no comparable facts"
      );
    }
    throw new BaselineError(
      "BASELINE_INCOMPARABLE",
      `Baseline does not match its schema: ${parsed.error.message}`
    );
  };

  private readonly readReport = async (path: string): Promise<TapHoundReport> => {
    let report: TapHoundReport;
    try {
      report = TapHoundReportV4Schema.parse(JSON.parse(
        await this.dependencies.readText(path)
      ));
    } catch {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `A valid V4 report is required: ${path}`
      );
    }
    if (
      report.status === "passed"
      && (
        report.primaryFailure !== undefined
        || report.layers.run !== "passed"
      || report.steps.some((step) => step.status !== "passed")
        || report.checkpoints?.some((checkpoint) => checkpoint.status !== "passed")
      )
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "A passed report contains failed or incomplete replay evidence"
      );
    }
    return report;
  };

  private readonly readPassingVerdict = async (
    path: string,
    reportPath: string,
    report: TapHoundReport,
    expectedContractSha256?: string,
    allowCheckpointFailure = false
  ): Promise<string> => {
    let verdict;
    try {
      verdict = ContractVerdictViewSchema.parse(JSON.parse(
        await this.dependencies.readText(path)
      ));
    } catch {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        `A valid passing Contract Verdict is required: ${path}`
      );
    }
    if (
      !(
        (verdict.verdict === "pass" && verdict.reportStatus === "passed")
        || (allowCheckpointFailure
          && verdict.verdict === "fail"
          && verdict.reason === "CHECKPOINT_FAILED"
          && verdict.reportStatus === "failed")
      )
      || verdict.reportPath === undefined
      || resolve(verdict.reportPath) !== resolve(reportPath)
      || verdict.journeySha256 !== report.journey.sha256
      || verdict.environment.packageName !== report.project.packageName
      || (
        expectedContractSha256 !== undefined
        && verdict.contractSha256 !== expectedContractSha256
      )
    ) {
      throw new BaselineError(
        "BASELINE_INCOMPARABLE",
        "Contract Verdict does not establish this report and Contract identity"
      );
    }
    return verdict.contractSha256;
  };
}