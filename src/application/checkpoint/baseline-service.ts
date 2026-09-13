import type { Baseline, RegressionCompareResult } from "../../domain/checkpoint.js";
import { BaselineSchema, RegressionCompareResultSchema } from "../../domain/checkpoint.js";
import { TapHoundReportV4Schema, type TapHoundReport } from "../../domain/report.js";
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
    }
  ): Promise<Baseline> => {
    const report = await this.readReport(reportPath);
    const baseline = this.capturer.capture({
      id: input.id ?? report.runId,
      journeySha256: input.journeySha256 ?? report.journey.sha256,
      ...(input.contractSha256 === undefined
        ? {}
        : { contractSha256: input.contractSha256 }),
      capturedAt: new Date(this.dependencies.now()).toISOString(),
      runId: report.runId,
      packageName: report.project.packageName,
      result: {
        report,
        hookOutcomes: [],
        status: report.status === "passed" ? "passed" : "failed",
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
  }): Promise<RegressionCompareResult> => {
    const baseline = await this.readBaseline(input.baselinePath);
    const report = await this.readReport(input.reportPath);
    const requested = input.journeySha256 ?? baseline.journeySha256;
    if (requested !== baseline.journeySha256) {
      throw new Error(
        `Baseline ${baseline.id} binds journey ${baseline.journeySha256}, but the comparison requested ${requested}`
      );
    }
    const result = compareRegression({
      baseline,
      current: report,
      journeySha256: requested,
      comparedAt: new Date(this.dependencies.now()).toISOString()
    });
    return RegressionCompareResultSchema.parse(result);
  };

  private readonly readBaseline = async (path: string): Promise<Baseline> => {
    const text = await this.dependencies.readText(path);
    return BaselineSchema.parse(JSON.parse(text));
  };

  private readonly readReport = async (path: string): Promise<TapHoundReport> => {
    const text = await this.dependencies.readText(path);
    return TapHoundReportV4Schema.parse(JSON.parse(text));
  };
}