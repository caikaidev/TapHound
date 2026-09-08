import type {
  AnchorDefinition,
  ScreenDefinition,
  TransitionDefinition
} from "../../domain/knowledge.js";
import type { KnowledgeReceipt } from "../../domain/knowledge-receipt.js";
import type {
  KnowledgeRegistryPort,
  LoadedKnowledgeBundle,
  WriteKnowledgeBundleResult
} from "../../ports/knowledge-registry.js";
import type { KnowledgeReceiptStore } from "../../ports/knowledge-receipt-store.js";
import { KnowledgeLoader } from "./knowledge-loader.js";

export interface KnowledgeEvolutionSummary {
  transitionsUpdated: number;
  anchorsUpgraded: number;
  screensUpgraded: number;
}

export type KnowledgeEvolutionResult =
  | {
    status: "unchanged";
    knowledgeHash: string;
    revision: number;
    foldedReceipts: number;
  }
  | {
    status: "evolved";
    knowledgeHash: string;
    revision: number;
    foldedReceipts: number;
    summary: KnowledgeEvolutionSummary;
  };

interface TransitionObservationDelta {
  attempts: number;
  successes: number;
  recoveryCost: number;
}

function transitionDelta(
  transition: TransitionDefinition,
  delta: TransitionObservationDelta
): TransitionDefinition {
  const attempts = transition.observations.attempts + delta.attempts;
  const successes = transition.observations.successes + delta.successes;
  return {
    ...transition,
    status: transition.status === "inferred" && successes >= 1
      ? "observed"
      : transition.status,
    observations: {
      attempts,
      successes,
      recoveryCost: (
        transition.observations.recoveryCost + delta.recoveryCost
      )
    }
  };
}

export class KnowledgeEvolutionService {
  public constructor(private readonly dependencies: {
    registry: Pick<KnowledgeRegistryPort, "load" | "writePromoted">;
    receipts: Pick<KnowledgeReceiptStore, "list">;
  }) {}

  public readonly evolve = async (input: {
    projectRoot: string;
    packageName: string;
    expectedKnowledgeHash?: string | undefined;
  }): Promise<KnowledgeEvolutionResult> => {
    const loader = new KnowledgeLoader(this.dependencies.registry);
    const bundle = await loader.load({
      projectRoot: input.projectRoot,
      packageName: input.packageName,
      ...(input.expectedKnowledgeHash === undefined
        ? {}
        : { expectedKnowledgeHash: input.expectedKnowledgeHash })
    });
    const receipts = (await this.dependencies.receipts.list(
      input.projectRoot
    )).filter(
      (receipt) => receipt.knowledgeHash === bundle.knowledgeHash
    );

    const transitionDeltas = new Map<string, TransitionObservationDelta>();
    const observedAnchors = new Set<string>();
    const observedScreens = new Set<string>();
    for (const receipt of receipts) {
      this.collect(receipt, bundle, transitionDeltas, observedAnchors, observedScreens);
    }

    const transitions: TransitionDefinition[] = bundle.transitions.map(
      (transition) => {
        const delta = transitionDeltas.get(transition.id);
        return delta === undefined ? transition : transitionDelta(transition, delta);
      }
    );
    let transitionsUpdated = 0;
    for (const [index, transition] of transitions.entries()) {
      if (transition !== bundle.transitions[index]) transitionsUpdated += 1;
    }
    const anchors: AnchorDefinition[] = bundle.anchors.map((anchor) => (
      observedAnchors.has(anchor.id) && anchor.status === "inferred"
        ? { ...anchor, status: "observed" as const }
        : anchor
    ));
    const anchorsUpgraded = anchors.filter(
      (anchor, index) => anchor !== bundle.anchors[index]
    ).length;
    const screens: ScreenDefinition[] = bundle.screens.map((screen) => (
      observedScreens.has(screen.id) && screen.status === "inferred"
        ? { ...screen, status: "observed" as const }
        : screen
    ));
    const screensUpgraded = screens.filter(
      (screen, index) => screen !== bundle.screens[index]
    ).length;

    if (
      transitionsUpdated === 0
      && anchorsUpgraded === 0
      && screensUpgraded === 0
    ) {
      return {
        status: "unchanged",
        knowledgeHash: bundle.knowledgeHash,
        revision: bundle.index.revision,
        foldedReceipts: receipts.length
      };
    }

    const written: WriteKnowledgeBundleResult = (
      await this.dependencies.registry.writePromoted({
        projectRoot: input.projectRoot,
        packageName: input.packageName,
        expectedKnowledgeHash: bundle.knowledgeHash,
        anchors,
        screens,
        transitions
      })
    );
    return {
      status: "evolved",
      knowledgeHash: written.knowledgeHash,
      revision: written.revision,
      foldedReceipts: receipts.length,
      summary: {
        transitionsUpdated,
        anchorsUpgraded,
        screensUpgraded
      }
    };
  };

  private readonly collect = (
    receipt: KnowledgeReceipt,
    bundle: LoadedKnowledgeBundle,
    transitionDeltas: Map<string, TransitionObservationDelta>,
    observedAnchors: Set<string>,
    observedScreens: Set<string>
  ): void => {
    if (receipt.kind === "anchorResolution") {
      if (receipt.result !== "matched") return;
      if (!bundle.anchors.some((anchor) => anchor.id === receipt.anchorId)) {
        throw new Error(
          `Knowledge receipt references an unknown Anchor: ${receipt.anchorId}`
        );
      }
      observedAnchors.add(receipt.anchorId);
      return;
    }
    if (receipt.kind === "transitionVerification") {
      const transition = bundle.transitions.find(
        (candidate) => candidate.id === receipt.transitionId
      );
      if (transition === undefined) {
        throw new Error(
          `Knowledge receipt references an unknown Transition: ${receipt.transitionId}`
        );
      }
      const delta = transitionDeltas.get(receipt.transitionId)
        ?? { attempts: 0, successes: 0, recoveryCost: 0 };
      delta.attempts += 1;
      if (receipt.result === "verified") delta.successes += 1;
      if (receipt.result === "deviated") delta.recoveryCost += 1;
      transitionDeltas.set(receipt.transitionId, delta);
      return;
    }
    if (receipt.kind === "screenDetection") {
      if (receipt.result.status !== "matched") return;
      const detection = receipt.result;
      if (!bundle.screens.some((screen) => screen.id === detection.screenId)) {
        throw new Error(
          `Knowledge receipt references an unknown Screen: ${detection.screenId}`
        );
      }
      observedScreens.add(detection.screenId);
      for (const evidence of detection.evidence) {
        if (evidence.result !== "matched") continue;
        if (!bundle.anchors.some((anchor) => anchor.id === evidence.anchorId)) {
          throw new Error(
            `Knowledge receipt references an unknown Anchor: ${evidence.anchorId}`
          );
        }
        observedAnchors.add(evidence.anchorId);
      }
    }
  };
}
