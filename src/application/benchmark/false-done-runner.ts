import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import type { ContractVerifyInput, ContractVerifyResult } from "../contract/contract-verifier.js";
import {
  FalseDoneCaseResultSchema,
  FalseDoneRunResultSchema,
  type FalseDoneCase,
  type FalseDoneCaseResult,
  type FalseDoneDetection,
  type FalseDoneRunResult
} from "../../domain/false-done.js";
import type { ContractVerdictView } from "../../domain/contract.js";
import type { FalseDoneStore } from "../../ports/false-done-store.js";
import { ContractLoader } from "../contract/contract-loader.js";

export interface FalseDoneRunnerDependencies {
  store: FalseDoneStore;
  installApk: (input: {
    deviceSerial: string;
    apkPath: string;
  }) => Promise<void>;
  verifyContract: (input: ContractVerifyInput) => Promise<ContractVerifyResult>;
  readText: (path: string) => Promise<string>;
  readBytes: (path: string) => Promise<Uint8Array>;
  now: () => Date;
  createRunId: () => string;
}

export interface FalseDoneValidateIssue {
  id: string;
  ok: boolean;
  issues: string[];
}

export interface FalseDoneValidateOutput {
  status: "valid" | "invalid";
  cases: FalseDoneValidateIssue[];
}

export interface FalseDoneRunInput {
  projectRoot: string;
  deviceSerial: string;
  caseIds?: readonly string[] | undefined;
  repeats?: number | undefined;
  config: ContractVerifyInput["config"];
  toolVersions: Record<string, string>;
  manualReplay?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

function detectionFor(
  expected: FalseDoneCase["expectedVerdict"],
  actual: ContractVerdictView["verdict"] | undefined
): FalseDoneDetection {
  if (actual === undefined) {
    return "error";
  }
  if (expected === "pass") {
    return actual === "pass" ? "confirmed" : "falseReject";
  }
  switch (actual) {
  case "pass":
    return "missed";
  case "needsReview":
    return "detected";
  case "fail":
    return "detected";
  case "inconclusive":
    return "detected";
  case "invalid":
    return "detected";
  }
}

function anchorUnresolvedCount(view: ContractVerdictView): number {
  return [
    ...view.preconditions,
    ...view.assertions
  ].filter((entry) => entry.status === "unresolved").length;
}

function evidenceInsufficient(view: ContractVerdictView): boolean {
  return view.evidence.some((entry) => entry.required && !entry.satisfied);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FalseDoneRunner {
  private readonly loader: ContractLoader;

  public constructor(private readonly dependencies: FalseDoneRunnerDependencies) {
    this.loader = new ContractLoader({
      readText: dependencies.readText
    });
  }

  public readonly validate = async (input: {
    projectRoot: string;
    caseIds?: readonly string[] | undefined;
  }): Promise<FalseDoneValidateOutput> => {
    const cases = await this.dependencies.store.readCases(
      input.projectRoot,
      input.caseIds
    );
    const issues: FalseDoneValidateIssue[] = [];
    for (const item of cases) {
      const itemIssues: string[] = [];
      if (item.expectedVerdict === "pass" && item.category !== "correct") {
        itemIssues.push(
          "A false-done case with expectedVerdict=pass must use category=correct"
        );
      }
      try {
        await this.loader.load({
          projectRoot: input.projectRoot,
          contractPath: resolvePath(input.projectRoot, item.contractPath)
        });
      } catch (error) {
        itemIssues.push(
          error instanceof Error ? error.message : String(error)
        );
      }
      issues.push({
        id: item.id,
        ok: itemIssues.length === 0,
        issues: itemIssues
      });
    }
    return {
      status: issues.every((entry) => entry.ok) ? "valid" : "invalid",
      cases: issues
    };
  };

  public readonly run = async (
    input: FalseDoneRunInput
  ): Promise<{ result: FalseDoneRunResult; path: string }> => {
    const startedAt = this.dependencies.now();
    const repeats = input.repeats ?? 1;
    const cases = await this.dependencies.store.readCases(
      input.projectRoot,
      input.caseIds
    );
    const results: FalseDoneCaseResult[] = [];
    for (const item of cases) {
      results.push(await this.runCase(input, item, repeats));
    }
    const result = FalseDoneRunResultSchema.parse({
      version: 1,
      runId: this.dependencies.createRunId(),
      startedAt: startedAt.toISOString(),
      completedAt: this.dependencies.now().toISOString(),
      deviceSerial: input.deviceSerial,
      repeats,
      results,
      metrics: metricsFor(results, repeats)
    });
    const path = await this.dependencies.store.writeResult({
      projectRoot: input.projectRoot,
      result
    });
    return { result, path };
  };

  private readonly runCase = async (
    input: FalseDoneRunInput,
    item: FalseDoneCase,
    repeats: number
  ): Promise<FalseDoneCaseResult> => {
    const apkPath = resolvePath(input.projectRoot, item.variant.apkPath);
    let apkSha256: string;
    try {
      const bytes = await this.dependencies.readBytes(apkPath);
      apkSha256 = sha256Bytes(bytes);
    } catch (error) {
      return this.errorResult(item, repeats, "0".repeat(64), `Variant APK is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    try {
      await this.dependencies.installApk({
        deviceSerial: input.deviceSerial,
        apkPath
      });
    } catch (error) {
      return this.errorResult(item, repeats, apkSha256, `Variant APK install failed: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    const verdicts: ContractVerdictView["verdict"][] = [];
    let contractSha256: string | undefined;
    let latest: ContractVerifyResult | undefined;
    let lastError: string | undefined;
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      try {
        latest = await this.dependencies.verifyContract({
          projectRoot: input.projectRoot,
          config: input.config,
          devices: [{
            role: "default",
            deviceSerial: input.deviceSerial
          }],
          toolVersions: input.toolVersions,
          contractPath: resolvePath(input.projectRoot, item.contractPath),
          ...(input.manualReplay === undefined
            ? {}
            : { manualReplay: input.manualReplay }),
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        if (contractSha256 === undefined) {
          contractSha256 = latest.view.contractSha256;
        }
        verdicts.push(latest.view.verdict);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    const actual = verdicts.at(-1);
    if (actual === undefined) {
      return this.errorResult(item, repeats, apkSha256,
        lastError ?? "verifyContract produced no verdict");
    }
    const stable = verdicts.length > 1
      ? new Set(verdicts).size === 1
      : undefined;
    return FalseDoneCaseResultSchema.parse({
      caseId: item.id,
      category: item.category,
      variantLabel: item.variant.label,
      apkSha256,
      expectedVerdict: item.expectedVerdict,
      actualVerdict: actual,
      detection: detectionFor(item.expectedVerdict, actual),
      ...(contractSha256 === undefined ? {} : { contractSha256 }),
      ...(latest === undefined ? {} : {
        verdictReason: latest.view.reason,
        reportStatus: latest.view.reportStatus
      }),
      anchorUnresolved: latest === undefined
        ? 0
        : anchorUnresolvedCount(latest.view),
      ...(latest === undefined ? {} : {
        evidenceInsufficient: evidenceInsufficient(latest.view)
      }),
      attempts: verdicts.length,
      ...(stable === undefined ? {} : { stableAcrossAttempts: stable })
    });
  };

  private readonly errorResult = (
    item: FalseDoneCase,
    repeats: number,
    apkSha256: string,
    message: string
  ): FalseDoneCaseResult => FalseDoneCaseResultSchema.parse({
    caseId: item.id,
    category: item.category,
    variantLabel: item.variant.label,
    apkSha256,
    expectedVerdict: item.expectedVerdict,
    detection: "error",
    anchorUnresolved: 0,
    error: message,
    attempts: 1
  });
}

function metricsFor(
  results: readonly FalseDoneCaseResult[],
  repeats: number
): FalseDoneRunResult["metrics"] {
  const eligible = results.length;
  const falseDoneExpected = results.filter(
    (result) => result.expectedVerdict !== "pass"
  ).length;
  const falseDoneDetected = results.filter(
    (result) => result.detection === "detected"
  ).length;
  const missedCount = results.filter(
    (result) => result.detection === "missed"
  ).length;
  const falseRejectCount = results.filter(
    (result) => result.detection === "falseReject"
  ).length;
  const errorCount = results.filter(
    (result) => result.detection === "error"
  ).length;
  const agreed = results.filter(
    (result) => result.detection === "confirmed"
      || result.detection === "detected"
  ).length;
  const measuredStable = results.filter(
    (result) => result.attempts > 1
      && result.stableAcrossAttempts === true
  );
  const stabilityEligible = results.filter(
    (result) => result.attempts > 1
  );
  const anchorUnresolvedTotal = results.reduce(
    (total, result) => total + result.anchorUnresolved,
    0
  );
  const evidenceInsufficientTotal = results.filter(
    (result) => result.evidenceInsufficient === true
  ).length;
  return {
    eligibleCases: eligible,
    falseDoneExpected,
    falseDoneDetected,
    falseDoneRecall: falseDoneExpected === 0
      ? null
      : falseDoneDetected / falseDoneExpected,
    missedCount,
    falseRejectCount,
    falseRejectRate: eligible - falseDoneExpected === 0
      ? null
      : falseRejectCount / (eligible - falseDoneExpected),
    verdictAgreementRate: eligible === 0 ? null : agreed / eligible,
    errorCount,
    replayStabilityRate: repeats > 1 && stabilityEligible.length > 0
      ? measuredStable.length / stabilityEligible.length
      : null,
    anchorUnresolvedTotal,
    evidenceInsufficientTotal
  };
}