import {
  KnowledgePromotionSchema,
  type KnowledgePromotion
} from "../../domain/knowledge-receipt.js";
import type {
  LoadedKnowledgeBundle,
  KnowledgeRegistryPort,
  WriteKnowledgeBundleResult
} from "../../ports/knowledge-registry.js";
import type {
  KnowledgeReceiptStore
} from "../../ports/knowledge-receipt-store.js";
import type { KnowledgeReceipt } from "../../domain/knowledge-receipt.js";

function priorStatuses(
  bundle: LoadedKnowledgeBundle
): {
  anchors: ReadonlyMap<string, string>;
  screens: ReadonlyMap<string, string>;
  transitions: ReadonlyMap<string, string>;
} {
  return {
    anchors: new Map(bundle.anchors.map((entity) => [entity.id, entity.status])),
    screens: new Map(bundle.screens.map((entity) => [entity.id, entity.status])),
    transitions: new Map(
      bundle.transitions.map((entity) => [entity.id, entity.status])
    )
  };
}

function assertReceiptAuthorization(input: {
  promotion: KnowledgePromotion;
  current: LoadedKnowledgeBundle;
  receipts: readonly KnowledgeReceipt[];
}): void {
  const prior = priorStatuses(input.current);
  const matchedAnchors = new Set<string>();
  const matchedScreens = new Set<string>();
  const verifiedTransitions = new Map<string, Set<string>>();
  for (const receipt of input.receipts) {
    if (receipt.kind === "anchorResolution" && receipt.result === "matched") {
      matchedAnchors.add(receipt.anchorId);
    } else if (
      receipt.kind === "screenDetection"
      && receipt.result.status === "matched"
    ) {
      matchedScreens.add(receipt.result.screenId);
      for (const evidence of receipt.result.evidence) {
        if (evidence.result === "matched") {
          matchedAnchors.add(evidence.anchorId);
        }
      }
    } else if (
      receipt.kind === "transitionVerification"
      && receipt.result === "verified"
      && receipt.actualScreen === receipt.expectedScreen
    ) {
      const screens = verifiedTransitions.get(receipt.transitionId)
        ?? new Set<string>();
      screens.add(receipt.expectedScreen);
      verifiedTransitions.set(receipt.transitionId, screens);
    }
  }
  for (const anchor of input.promotion.anchors) {
    if (
      anchor.status === "verified"
      && prior.anchors.get(anchor.id) !== "verified"
      && !matchedAnchors.has(anchor.id)
    ) {
      throw new Error(
        `Promotion of Anchor ${anchor.id} is not authorized by the supplied receipts`
      );
    }
  }
  for (const screen of input.promotion.screens) {
    if (
      screen.status === "verified"
      && prior.screens.get(screen.id) !== "verified"
      && !matchedScreens.has(screen.id)
    ) {
      throw new Error(
        `Promotion of Screen ${screen.id} is not authorized by the supplied receipts`
      );
    }
  }
  for (const transition of input.promotion.transitions) {
    if (
      transition.status === "verified"
      && prior.transitions.get(transition.id) !== "verified"
      && !verifiedTransitions.get(transition.id)?.has(transition.toScreen)
    ) {
      throw new Error(
        `Promotion of Transition ${transition.id} is not authorized by the supplied receipts`
      );
    }
  }
}

export class KnowledgePromotionService {
  public constructor(private readonly dependencies: {
    registry: Pick<KnowledgeRegistryPort, "load" | "writePromoted">;
    receipts: Pick<KnowledgeReceiptStore, "read">;
  }) {}

  public readonly promote = async (input: {
    projectRoot: string;
    packageName: string;
    promotion: KnowledgePromotion;
  }): Promise<WriteKnowledgeBundleResult> => {
    const promotion = KnowledgePromotionSchema.parse(input.promotion);
    const current = await this.dependencies.registry.load(input.projectRoot);
    if (current.knowledgeHash !== promotion.expectedKnowledgeHash) {
      throw new Error(
        "Knowledge changed after the promotion proposal was created"
      );
    }
    const receipts: KnowledgeReceipt[] = [];
    for (const receiptId of promotion.receiptIds) {
      const receipt = await this.dependencies.receipts.read({
        projectRoot: input.projectRoot,
        receiptId
      });
      if (receipt.knowledgeHash !== promotion.expectedKnowledgeHash) {
        throw new Error(
          `Receipt ${receiptId} is not bound to the promoted Knowledge version`
        );
      }
      receipts.push(receipt);
    }
    assertReceiptAuthorization({ promotion, current, receipts });
    return this.dependencies.registry.writePromoted({
      projectRoot: input.projectRoot,
      packageName: input.packageName,
      expectedKnowledgeHash: promotion.expectedKnowledgeHash,
      anchors: promotion.anchors,
      screens: promotion.screens,
      transitions: promotion.transitions
    });
  };
}
