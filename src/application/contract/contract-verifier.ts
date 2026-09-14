import type { TapHoundConfig } from "../../domain/config.js";
import {
  CONTRACT_VERDICT_POLICY_VERSION,
  ContractVerdictViewSchema,
  type AcceptanceContract,
  type ContractAssertion,
  type ContractAssertionOutcome,
  type ContractPrecondition,
  type ContractPreconditionOutcome,
  type ContractVerdict,
  type ContractVerdictReason,
  type ContractVerdictView
} from "../../domain/contract.js";
import type { FailureCode } from "../../domain/failure.js";
import type { RuntimeSnapshotV1 } from "../../domain/runtime-snapshot.js";
import type { DeviceAssignment } from "../devices/resolve-device-assignments.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { ScreenDetector } from "../recognition/screen-detector.js";
import type { LoadedKnowledgeBundle } from "../../ports/knowledge-registry.js";
import type {
  VerifyHookContext,
  VerifyHookResult,
  VerifyHooks,
  VerifyInput,
  VerifyResult
} from "../runtime/verify-runtime.js";
import { ContractError, ContractLoader } from "./contract-loader.js";

export interface ContractVerifyInput {
  projectRoot: string;
  workspaceRoot?: string | undefined;
  config: TapHoundConfig;
  devices: DeviceAssignment[];
  toolVersions: Record<string, string>;
  taphoundVersion?: string | undefined;
  contractPath: string;
  manualReplay?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface ContractVerifierDependencies {
  verify: (input: VerifyInput) => Promise<VerifyResult>;
  loadKnowledge?: ((input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    packageName: string;
  }) => Promise<LoadedKnowledgeBundle>) | undefined;
  readText: (path: string) => Promise<string>;
  writeVerdict?: ((input: {
    reportPath: string;
    verdict: ContractVerdictView;
  }) => Promise<void>) | undefined;
  now: () => Date;
}

export interface ContractVerifyResult {
  view: ContractVerdictView;
  exitCode: 0 | 1 | 2 | 3 | 4;
}

type Assessed =
  | { status: "passed" }
  | { status: "failed"; message: string }
  | { status: "unresolved"; message: string };

function aggregateStatus(
  outcomes: readonly ContractPreconditionOutcome[]
): VerifyHookResult {
  if (outcomes.some((outcome) => outcome.status === "failed")) {
    return { status: "failed" };
  }
  if (outcomes.some((outcome) => outcome.status === "unresolved")) {
    return { status: "unresolved" };
  }
  return { status: "passed" };
}

function aggregateAssertionStatus(
  outcomes: readonly ContractAssertionOutcome[]
): VerifyHookResult {
  if (outcomes.some((outcome) => outcome.status === "failed")) {
    return { status: "failed" };
  }
  if (outcomes.some((outcome) => outcome.status === "unresolved")) {
    return { status: "unresolved" };
  }
  return { status: "passed" };
}

function reasonForFailureCode(code: FailureCode): ContractVerdictReason {
  switch (code) {
  case "CONTRACT_JOURNEY_DRIFT":
    return "JOURNEY_DRIFT";
  case "CONTRACT_JOURNEY_MISSING":
    return "JOURNEY_MISSING";
  case "CONTRACT_KNOWLEDGE_UNAVAILABLE":
    return "KNOWLEDGE_UNAVAILABLE";
  default:
    return "CONTRACT_INVALID";
  }
}

export class ContractVerifier {
  private readonly loader: ContractLoader;
  private readonly detector = new ScreenDetector();

  public constructor(private readonly dependencies: ContractVerifierDependencies) {
    this.loader = new ContractLoader({
      readText: dependencies.readText
    });
  }

  public readonly verify = async (
    input: ContractVerifyInput
  ): Promise<ContractVerifyResult> => {
    const startedAt = new Date(this.dependencies.now()).toISOString();
    const environment: ContractVerdictView["environment"] = {
      projectRoot: input.projectRoot,
      packageName: input.config.run.packageName,
      devices: input.devices.map((device) => device.deviceSerial)
    };
    const provenance: ContractVerdictView["provenance"] = {
      policyVersion: CONTRACT_VERDICT_POLICY_VERSION,
      ...(input.taphoundVersion === undefined
        ? {}
        : { taphoundVersion: input.taphoundVersion }),
      ...(Object.keys(input.toolVersions).length === 0
        ? {}
        : { toolVersions: input.toolVersions })
    };

    let loaded;
    try {
      loaded = await this.loader.load({
        projectRoot: input.projectRoot,
        workspaceRoot: input.workspaceRoot,
        contractPath: input.contractPath
      });
    } catch (error) {
      const contractError = error instanceof ContractError ? error : undefined;
      const code: FailureCode = contractError?.code ?? "CONTRACT_INVALID";
      const reason = reasonForFailureCode(code);
      return {
        view: this.invalidView(startedAt, {
          reason,
          message: contractError?.message
            ?? "Acceptance Contract could not be loaded",
          environment,
          provenance
        }),
        exitCode: 2
      };
    }

    const contract = loaded.contract;
    const needsKnowledge = contract.targetScreen !== undefined
      || contract.preconditions.some(
      (precondition) => precondition.kind === "screen"
        || precondition.kind === "anchor"
    ) || contract.assertions.some(
      (assertion) => assertion.type === "screen"
    );
    let knowledge: LoadedKnowledgeBundle | undefined;
    if (needsKnowledge) {
      if (this.dependencies.loadKnowledge === undefined) {
        return {
          view: this.invalidView(startedAt, {
            reason: "KNOWLEDGE_UNAVAILABLE",
            message: "This Contract needs Project Knowledge (screen/anchor terms) but no knowledge loader is configured",
            environment,
            provenance
          }),
          exitCode: 2
        };
      }
      try {
        knowledge = await this.dependencies.loadKnowledge({
          projectRoot: input.projectRoot,
          workspaceRoot: input.workspaceRoot,
          packageName: input.config.run.packageName
        });
      } catch (error) {
        return {
          view: this.invalidView(startedAt, {
            reason: "KNOWLEDGE_UNAVAILABLE",
            message: `Project Knowledge is unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
            environment,
            provenance
          }),
          exitCode: 2
        };
      }
    }
    if (
      contract.targetScreen !== undefined
      && !knowledge?.screens.some(
        (screen) => screen.id === contract.targetScreen
      )
    ) {
      return {
        view: this.invalidView(startedAt, {
          reason: "KNOWLEDGE_UNAVAILABLE",
          message: `Contract targetScreen ${contract.targetScreen} is not present in Project Knowledge`,
          environment,
          provenance
        }),
        exitCode: 2
      };
    }

    const preconditionOutcomes: ContractPreconditionOutcome[] = [];
    const assertionOutcomes: ContractAssertionOutcome[] = [];
    const hooks: VerifyHooks = {
      beforeSteps: async (context) => {
        const outcomes = await this.evaluatePreconditions(
          context,
          contract,
          knowledge,
          input.config.run.packageName
        );
        preconditionOutcomes.push(...outcomes);
        const result = aggregateStatus(preconditionOutcomes);
        const screen = contract.preconditions.find(
          (precondition, index) => (
            precondition.kind === "screen"
            && outcomes[index]?.status === "passed"
          )
        );
        return screen?.kind === "screen"
          ? { ...result, screen: screen.screen }
          : result;
      },
      afterSteps: async (context) => {
        const outcomes = await this.evaluateAssertions(
          context,
          contract,
          knowledge,
          input.config.run.packageName
        );
        assertionOutcomes.push(...outcomes);
        const result = aggregateAssertionStatus(assertionOutcomes);
        const screen = contract.assertions.find(
          (assertion, index) => (
            assertion.type === "screen"
            && outcomes[index]?.status === "passed"
          )
        );
        return screen?.type === "screen"
          ? { ...result, screen: screen.screen }
          : result;
      }
    };

    let runResult: VerifyResult;
    try {
      runResult = await this.dependencies.verify({
        config: input.config,
        journey: loaded.journey,
        projectRoot: input.projectRoot,
        ...(input.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: input.workspaceRoot }),
        devices: input.devices,
        toolVersions: input.toolVersions,
        ...(input.manualReplay === undefined
          ? {}
          : { manualReplay: input.manualReplay }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        hooks
      });
    } catch (error) {
      return {
        view: this.invalidView(startedAt, {
          reason: "CONTRACT_INVALID",
          message: `Runtime verification failed to start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          environment,
          provenance
        }),
        exitCode: 4
      };
    }

    const report = runResult.report;
    const evidence = this.checkEvidence(contract, report);
    const evidenceInsufficient = evidence.some(
      (entry) => entry.required && !entry.satisfied
    );
    const beforeOutcome = (runResult.hookOutcomes ?? []).find(
      (outcome) => outcome.phase === "beforeSteps"
    );
    const afterOutcome = (runResult.hookOutcomes ?? []).find(
      (outcome) => outcome.phase === "afterSteps"
    );
    const { preconditions, assertions } = this.withNotRun(
      contract,
      preconditionOutcomes,
      assertionOutcomes
    );

    let verdict: ContractVerdict;
    let reason: ContractVerdictReason;
    let message: string;
    let exitCode: 0 | 1 | 2 | 3 | 4;
    switch (runResult.status) {
    case "error":
      verdict = "inconclusive";
      reason = "RUN_ERROR";
      message = report.primaryFailure?.message ?? "Runtime verification errored";
      exitCode = 1;
      break;
    case "manualRequired":
      verdict = "inconclusive";
      reason = "RUN_MANUAL_REQUIRED";
      message = report.primaryFailure?.message
        ?? "The Journey requires manual replay";
      exitCode = 1;
      break;
    case "failed":
      verdict = "fail";
      reason = "RUN_FAILED";
      message = report.primaryFailure?.message ?? "Journey replay failed";
      exitCode = runResult.exitCode === 0 ? 1 : runResult.exitCode;
      break;
    case "passed":
      if (beforeOutcome?.status === "failed") {
        verdict = "fail";
        reason = "PRECONDITION_FAILED";
        message = "A Contract precondition failed before the Journey ran";
        exitCode = 1;
        break;
      }
      if (beforeOutcome?.status === "unresolved") {
        verdict = "inconclusive";
        reason = "PRECONDITION_UNRESOLVED";
        message = "A Contract precondition could not be determined";
        exitCode = 1;
        break;
      }
      if (afterOutcome?.status === "failed") {
        verdict = "fail";
        reason = "ASSERTION_FAILED";
        message = "A Contract assertion failed after the Journey";
        exitCode = 1;
        break;
      }
      if (afterOutcome?.status === "unresolved") {
        verdict = "inconclusive";
        reason = "ASSERTION_UNRESOLVED";
        message = "A Contract assertion could not be determined";
        exitCode = 1;
        break;
      }
      if (evidenceInsufficient) {
        verdict = "inconclusive";
        reason = "EVIDENCE_INSUFFICIENT";
        message = "Required runtime evidence is missing from the run";
        exitCode = 1;
        break;
      }
      verdict = "pass";
      reason = "CONTRACT_OK";
      message = "Acceptance Contract satisfied by runtime evidence";
      exitCode = 0;
      break;
    }

    const view = ContractVerdictViewSchema.parse({
      version: 1,
      contractId: contract.id,
      contractSha256: loaded.contractSha256,
      journeySha256: contract.journey.sha256,
      verdict,
      reason,
      message,
      preconditions,
      assertions,
      evidence,
      reportPath: runResult.reportPath,
      reportStatus: runResult.status,
      startedAt,
      finishedAt: new Date(this.dependencies.now()).toISOString(),
      environment,
      provenance
    });
    if (this.dependencies.writeVerdict !== undefined) {
      await this.dependencies.writeVerdict({
        reportPath: runResult.reportPath,
        verdict: view
      });
    }
    return { view, exitCode };
  };

  private readonly invalidView = (
    startedAt: string,
    input: {
      reason: ContractVerdictReason;
      message: string;
      environment: ContractVerdictView["environment"];
      provenance?: ContractVerdictView["provenance"] | undefined;
    }
  ): ContractVerdictView => ContractVerdictViewSchema.parse({
    version: 1,
    contractId: "unknown",
    contractSha256: "0".repeat(64),
    journeySha256: "0".repeat(64),
    verdict: "invalid",
    reason: input.reason,
    message: input.message,
    preconditions: [],
    assertions: [],
    evidence: [],
    startedAt,
    finishedAt: new Date(this.dependencies.now()).toISOString(),
    environment: input.environment,
    ...(input.provenance === undefined ? {} : { provenance: input.provenance })
  });

  private readonly evaluatePreconditions = async (
    context: VerifyHookContext,
    contract: AcceptanceContract,
    knowledge: LoadedKnowledgeBundle | undefined,
    packageName: string
  ): Promise<ContractPreconditionOutcome[]> => {
    const outcomes: ContractPreconditionOutcome[] = [];
    for (const precondition of contract.preconditions) {
      const assessed = await this.assessPrecondition(
        precondition,
        context,
        knowledge,
        packageName
      );
      outcomes.push({
        kind: precondition.kind,
        status: assessed.status,
        ...(assessed.status === "passed" ? {} : { message: assessed.message })
      });
    }
    return outcomes;
  };

  private readonly assessPrecondition = async (
    precondition: ContractPrecondition,
    context: VerifyHookContext,
    knowledge: LoadedKnowledgeBundle | undefined,
    packageName: string
  ): Promise<Assessed> => {
    switch (precondition.kind) {
    case "installed":
      return { status: "passed" };
    case "activity":
      return this.checkActivity(
        precondition.activity,
        precondition.timeoutMs,
        context,
        packageName
      );
    case "anchor":
      return this.checkAnchor(precondition.anchor, context, knowledge);
    case "screen":
      return this.checkScreen(
        precondition.screen,
        precondition.timeoutMs,
        context,
        knowledge,
        packageName
      );
    }
  };

  private readonly evaluateAssertions = async (
    context: VerifyHookContext,
    contract: AcceptanceContract,
    knowledge: LoadedKnowledgeBundle | undefined,
    packageName: string
  ): Promise<ContractAssertionOutcome[]> => {
    const outcomes: ContractAssertionOutcome[] = [];
    for (const assertion of contract.assertions) {
      const assessed = await this.assessAssertion(
        assertion,
        context,
        knowledge,
        packageName
      );
      outcomes.push({
        type: assertion.type,
        status: assessed.status,
        ...(assessed.status === "passed" ? {} : { message: assessed.message })
      });
    }
    return outcomes;
  };

  private readonly assessAssertion = async (
    assertion: ContractAssertion,
    context: VerifyHookContext,
    knowledge: LoadedKnowledgeBundle | undefined,
    packageName: string
  ): Promise<Assessed> => {
    switch (assertion.type) {
    case "activity":
      return this.checkActivity(
        assertion.activity,
        assertion.timeoutMs,
        context,
        packageName
      );
    case "element":
      return this.checkElement(assertion, context);
    case "screen":
      return this.checkScreen(
        assertion.screen,
        assertion.timeoutMs,
        context,
        knowledge,
        packageName
      );
    }
  };

  private readonly checkActivity = async (
    expected: string,
    timeoutMs: number,
    context: VerifyHookContext,
    packageName: string
  ): Promise<Assessed> => {
    let actual: string;
    try {
      actual = await context.adb.currentActivity({
        packageName,
        deviceSerial: context.deviceSerial,
        timeoutMs
      });
    } catch (error) {
      return {
        status: "unresolved",
        message: `Activity lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
    if (actual === expected) {
      return { status: "passed" };
    }
    return {
      status: "failed",
      message: `Expected activity ${expected}, found ${actual}`
    };
  };

  private readonly checkAnchor = (
    anchorId: string,
    context: VerifyHookContext,
    knowledge: LoadedKnowledgeBundle | undefined
  ): Assessed => {
    if (knowledge === undefined) {
      return {
        status: "unresolved",
        message: "Project Knowledge is unavailable"
      };
    }
    const anchor = knowledge.anchors.find(
      (candidate) => candidate.id === anchorId
    );
    if (anchor === undefined) {
      return {
        status: "unresolved",
        message: `Anchor ${anchorId} is not defined in Project Knowledge`
      };
    }
    if (anchor.identity.kind !== "element") {
      return {
        status: "unresolved",
        message: `Anchor ${anchorId} does not carry an element identity; only element anchors support direct resolution`
      };
    }
    const resolution = resolveLocator(
      context.snapshot.roots,
      anchor.identity.locator,
      {
        requireEnabled: true,
        viewport: context.snapshot.viewport
      }
    );
    if (resolution.status === "found") {
      return { status: "passed" };
    }
    if (resolution.code === "LOCATOR_AMBIGUOUS") {
      return {
        status: "unresolved",
        message: `Anchor ${anchorId} is ambiguous in the current layout`
      };
    }
    return {
      status: "failed",
      message: `Anchor ${anchorId} was not found: ${resolution.message}`
    };
  };

  private readonly checkScreen = async (
    screenId: string,
    timeoutMs: number,
    context: VerifyHookContext,
    knowledge: LoadedKnowledgeBundle | undefined,
    packageName: string
  ): Promise<Assessed> => {
    if (knowledge === undefined) {
      return {
        status: "unresolved",
        message: "Project Knowledge is unavailable"
      };
    }
    const snapshot = await this.buildRuntimeSnapshot(
      context,
      packageName,
      timeoutMs
    );
    if (snapshot === undefined) {
      return {
        status: "unresolved",
        message: "Could not read the current Activity for screen detection"
      };
    }
    const detection = this.detector.detect({
      snapshot,
      anchors: knowledge.anchors,
      screens: knowledge.screens
    });
    if (detection.status === "matched") {
      if (detection.screenId === screenId) {
        return { status: "passed" };
      }
      return {
        status: "failed",
        message: `Expected screen ${screenId}, observed ${detection.screenId}`
      };
    }
    const message = detection.status === "ambiguous"
      ? `Screen detection is ambiguous: ${detection.screenIds.join(", ")}`
      : "Screen detection could not identify a screen";
    return { status: "unresolved", message };
  };

  private readonly buildRuntimeSnapshot = async (
    context: VerifyHookContext,
    packageName: string,
    timeoutMs: number
  ): Promise<RuntimeSnapshotV1 | undefined> => {
    let activity: string;
    try {
      activity = await context.adb.currentActivity({
        packageName,
        deviceSerial: context.deviceSerial,
        timeoutMs
      });
    } catch {
      return undefined;
    }
    return {
      version: 1,
      generationId: "contract",
      baseRevision: 1,
      deviceSerial: context.deviceSerial,
      expectedPackageName: packageName,
      foregroundPackageName: packageName,
      activity,
      pid: null,
      capturedAt: new Date(context.clock.now()).toISOString(),
      layout: [...context.snapshot.roots]
    };
  };

  private readonly checkElement = async (
    assertion: Extract<ContractAssertion, { type: "element" }>,
    context: VerifyHookContext
  ): Promise<Assessed> => {
    if (assertion.packageName !== undefined) {
      try {
        const foreground = await context.adb.foregroundComponent({
          packageName: assertion.packageName,
          deviceSerial: context.deviceSerial,
          timeoutMs: assertion.timeoutMs
        });
        if (foreground.packageName !== assertion.packageName) {
          return {
            status: "failed",
            message: `Expected foreground package ${assertion.packageName}, found ${foreground.packageName}`
          };
        }
      } catch (error) {
        return {
          status: "unresolved",
          message: `Foreground package lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
    }
    const resolution = resolveLocator(
      context.snapshot.roots,
      assertion.locator,
      {
        requireEnabled: false,
        viewport: context.snapshot.viewport
      }
    );
    if (resolution.status === "failed" && resolution.code === "LOCATOR_AMBIGUOUS") {
      return {
        status: "failed",
        message: `Element Locator is ambiguous: ${resolution.message}`
      };
    }
    const present = resolution.status === "found";
    if (assertion.visibility === "visible") {
      return present
        ? { status: "passed" }
        : {
            status: "failed",
            message: `Expected element to be visible: ${resolution.message}`
          };
    }
    return present
      ? {
          status: "failed",
          message: "Expected element to be absent but it was found"
        }
      : { status: "passed" };
  };

  private readonly checkEvidence = (
    contract: AcceptanceContract,
    report: VerifyResult["report"]
  ): ContractVerdictView["evidence"] => {
    const screenshotFinal = report.artifacts.screenshots.length > 0;
    const screenshotAnyStep = screenshotFinal || report.steps.some(
      (step) => step.locator?.annotatedScreenshotPath !== undefined
    );
    const uiHierarchyFinal = (
      report.artifacts.uiHierarchies?.length ?? 0
    ) > 0;
    const logcatFinal = report.artifacts.logcats.length > 0;
    const logcatAnyStep = report.steps.some(
      (step) => step.logcatPath !== undefined
    );
    const satisfiedFor = (requirement: {
      kind: "screenshot" | "uiHierarchy" | "logcat";
      scope: "final" | "anyStep";
    }): boolean => {
      switch (requirement.kind) {
      case "screenshot":
        return requirement.scope === "anyStep"
          ? screenshotAnyStep
          : screenshotFinal;
      case "uiHierarchy":
        return uiHierarchyFinal;
      case "logcat":
        return requirement.scope === "anyStep" ? logcatAnyStep : logcatFinal;
      }
    };
    return contract.evidenceRequirements.map((requirement) => {
      const satisfied = satisfiedFor(requirement);
      return {
        kind: requirement.kind,
        required: requirement.required,
        satisfied,
        ...(satisfied
          ? {}
          : {
              detail: `Run ${report.runId} has no ${requirement.kind} evidence for scope ${requirement.scope}`
            })
      };
    });
  };

  private readonly withNotRun = (
    contract: AcceptanceContract,
    preconditionOutcomes: ContractPreconditionOutcome[],
    assertionOutcomes: ContractAssertionOutcome[]
  ): {
    preconditions: ContractPreconditionOutcome[];
    assertions: ContractAssertionOutcome[];
  } => {
    const byKind = new Map(
      preconditionOutcomes.map((outcome) => [outcome.kind, outcome])
    );
    const preconditions = contract.preconditions.map((precondition) => (
      byKind.get(precondition.kind) ?? {
        kind: precondition.kind,
        status: "notRun" as const,
        message: "Precondition was not evaluated before the run completed"
      }
    ));
    const assertions = contract.assertions.map((assertion, index) => (
      assertionOutcomes[index] ?? {
        type: assertion.type,
        status: "notRun" as const,
        message: "Assertion was not evaluated because the run did not pass"
      }
    ));
    return { preconditions, assertions };
  };
}