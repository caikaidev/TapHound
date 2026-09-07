import {
  GenerationPlanningSchema,
  type GenerationPlanning,
  type GenerationSession
} from "../../domain/generation.js";
import {
  TransitionVerificationReceiptSchema
} from "../../domain/knowledge-receipt.js";
import {
  hashKnowledge
} from "../../domain/knowledge.js";
import type { RuntimeSnapshot } from "../../domain/runtime-snapshot.js";
import type { LoadedKnowledgeBundle } from "../../ports/knowledge-registry.js";
import { KnowledgeLoader } from "../knowledge/knowledge-loader.js";
import { KnowledgeReceiptRecorder } from "../knowledge/receipt-recorder.js";
import { InteractionGraph } from "../planning/interaction-graph.js";
import { RoutePlanner } from "../planning/route-planner.js";
import { ScreenDetector } from "../recognition/screen-detector.js";
import { ActionResolver, type ActionResolutionResult } from "../resolution/action-resolver.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface GenerationPlanningTiming {
  recognitionMs: number;
  planningMs: number;
}

export interface GenerationPlanningResult {
  planning: GenerationPlanning;
  knowledge: LoadedKnowledgeBundle;
  detectionReceiptPath: string;
  timing: GenerationPlanningTiming;
  transitionReceiptPath?: string | undefined;
  replanReceiptPath?: string | undefined;
}

export class GenerationPlanner {
  private readonly detector = new ScreenDetector();
  private readonly routePlanner = new RoutePlanner();
  private readonly resolver = new ActionResolver();

  public constructor(private readonly dependencies: {
    projectRoot: string;
    knowledge: KnowledgeLoader;
    receipts: KnowledgeReceiptRecorder;
    now: () => Date;
    createReceiptId: () => string;
  }) {}

  public readonly planSnapshot = async (
    session: GenerationSession,
    snapshot: RuntimeSnapshot,
    verifyTransition = false
  ): Promise<GenerationPlanningResult> => {
    if (session.version !== 2 || session.planning === undefined) {
      throw new GenerationOperationError(
        "KNOWLEDGE_INVALID",
        "Generation session has no planning binding"
      );
    }
    const knowledge = await this.dependencies.knowledge.load({
      projectRoot: this.dependencies.projectRoot,
      packageName: session.target.packageName,
      expectedKnowledgeHash: session.planning.knowledgeHash
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new GenerationOperationError(
        message.includes("hash changed") ? "KNOWLEDGE_STALE" : "KNOWLEDGE_INVALID",
        message
      );
    });
    const now = this.dependencies.now();
    const recognitionStartedAt = this.dependencies.now().getTime();
    const detectionReceipt = this.detector.receipt({
      id: this.dependencies.createReceiptId(),
      recordedAt: now.toISOString(),
      knowledgeHash: knowledge.knowledgeHash,
      snapshot,
      anchors: knowledge.anchors,
      screens: knowledge.screens
    });
    const recognitionMs = this.dependencies.now().getTime() - recognitionStartedAt;
    const detectionReceiptPath = await this.dependencies.receipts.record({
      projectRoot: this.dependencies.projectRoot,
      receipt: detectionReceipt
    });
    if (detectionReceipt.result.status === "ambiguous") {
      throw new GenerationOperationError(
        "SCREEN_AMBIGUOUS",
        `Runtime matches multiple Screens: ${detectionReceipt.result.screenIds.join(", ")}`,
        { receiptPath: detectionReceiptPath, result: detectionReceipt.result }
      );
    }
    if (detectionReceipt.result.status === "unknown") {
      throw new GenerationOperationError(
        "SCREEN_UNKNOWN",
        "Runtime does not deterministically match a known Screen",
        { receiptPath: detectionReceiptPath, result: detectionReceipt.result }
      );
    }

    const currentScreen = detectionReceipt.result.screenId;
    const previousRoute = session.planning.currentRoute;
    const expectedScreen = verifyTransition
      ? previousRoute?.segments[0]?.toScreen
      : session.planning.currentScreen ?? undefined;
    const deviated = expectedScreen !== undefined && expectedScreen !== currentScreen;
    let transitionReceiptPath: string | undefined;
    if (verifyTransition && expectedScreen !== undefined) {
      const transitionId = previousRoute?.segments[0]?.transitionId;
      if (transitionId !== undefined) {
        const receipt = TransitionVerificationReceiptSchema.parse({
          version: 1,
          id: this.dependencies.createReceiptId(),
          kind: "transitionVerification",
          recordedAt: now.toISOString(),
          knowledgeHash: knowledge.knowledgeHash,
          snapshotHash: detectionReceipt.snapshotHash,
          transitionId,
          expectedScreen,
          actualScreen: currentScreen,
          result: deviated ? "deviated" : "verified"
        });
        transitionReceiptPath = await this.dependencies.receipts.record({
          projectRoot: this.dependencies.projectRoot,
          receipt
        });
      }
    }
    const replansUsed = session.planning.replansUsed + (deviated ? 1 : 0);
    if (replansUsed > session.planning.maxReplans) {
      throw new GenerationOperationError(
        "REPLAN_BUDGET_EXHAUSTED",
        "Generation re-plan budget is exhausted",
        { transitionReceiptPath }
      );
    }
    const remainingSteps = session.planning.maxSteps - session.candidateSteps.length;
    if (remainingSteps <= 0 && currentScreen !== session.planning.goal.targetScreen) {
      throw new GenerationOperationError(
        "NO_ROUTE",
        "Generation planning step budget is exhausted"
      );
    }
    const graph = new InteractionGraph(
      knowledge.transitions,
      session.target.interactionPolicy.allowedActions
    );
    const planningStartedAt = this.dependencies.now().getTime();
    const planned = this.routePlanner.plan({
      goal: {
        ...session.planning.goal,
        limits: {
          ...session.planning.goal.limits,
          maxSteps: Math.max(1, remainingSteps)
        }
      },
      currentScreen,
      knowledgeHash: knowledge.knowledgeHash,
      screens: knowledge.screens,
      graph,
      now
    });
    const planningMs = this.dependencies.now().getTime() - planningStartedAt;
    if (planned.status === "failed") {
      throw new GenerationOperationError(
        "NO_ROUTE",
        planned.failure.message,
        planned.failure
      );
    }
    let replanReceiptPath: string | undefined;
    if (deviated && previousRoute !== null) {
      replanReceiptPath = await this.dependencies.receipts.record({
        projectRoot: this.dependencies.projectRoot,
        receipt: {
          version: 1,
          id: this.dependencies.createReceiptId(),
          kind: "replan",
          recordedAt: now.toISOString(),
          knowledgeHash: knowledge.knowledgeHash,
          snapshotHash: detectionReceipt.snapshotHash,
          goalId: session.planning.goal.id,
          previousRouteHash: hashKnowledge(previousRoute),
          nextRouteHash: hashKnowledge(planned.route),
          reason: verifyTransition ? "transitionDeviation" : "screenChanged",
          remainingBudget: session.planning.maxReplans - replansUsed
        }
      });
    }
    return {
      planning: GenerationPlanningSchema.parse({
        ...session.planning,
        currentScreen,
        currentRoute: planned.route,
        replansUsed
      }),
      knowledge,
      detectionReceiptPath,
      timing: {
        recognitionMs,
        planningMs
      },
      ...(transitionReceiptPath === undefined ? {} : { transitionReceiptPath }),
      ...(replanReceiptPath === undefined ? {} : { replanReceiptPath })
    };
  };

  public readonly resolveNext = (input: {
    session: GenerationSession;
    snapshot: RuntimeSnapshot;
    knowledge: LoadedKnowledgeBundle;
  }): ActionResolutionResult => {
    if (input.session.version !== 2 || input.session.planning === undefined) {
      throw new GenerationOperationError(
        "KNOWLEDGE_INVALID",
        "Generation session has no planning binding"
      );
    }
    const segment = input.session.planning.currentRoute?.segments[0];
    if (segment === undefined) {
      throw new GenerationOperationError(
        "NO_ROUTE",
        "Generation is already at the Goal Screen"
      );
    }
    const transition = input.knowledge.transitions.find(
      (candidate) => candidate.id === segment.transitionId
    );
    if (transition === undefined) {
      throw new GenerationOperationError(
        "KNOWLEDGE_STALE",
        `Route Transition no longer exists: ${segment.transitionId}`
      );
    }
    return this.resolver.resolve({
      transition,
      anchors: input.knowledge.anchors,
      screens: input.knowledge.screens,
      goal: input.session.planning.goal,
      binding: {
        generationId: input.session.id,
        baseRevision: input.snapshot.baseRevision,
        snapshotHash: input.session.bindings.snapshotHash as string
      },
      activity: input.snapshot.activity
    });
  };
}
