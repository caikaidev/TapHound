import {
  KnowledgePromotionSchema,
  type KnowledgePromotion
} from "../../domain/knowledge-receipt.js";
import type {
  KnowledgeRegistryPort,
  WriteKnowledgeBundleResult
} from "../../ports/knowledge-registry.js";
import type {
  KnowledgeReceiptStore
} from "../../ports/knowledge-receipt-store.js";

export class KnowledgePromotionService {
  public constructor(private readonly dependencies: {
    registry: Pick<KnowledgeRegistryPort, "writePromoted">;
    receipts: Pick<KnowledgeReceiptStore, "read">;
  }) {}

  public readonly promote = async (input: {
    projectRoot: string;
    packageName: string;
    promotion: KnowledgePromotion;
  }): Promise<WriteKnowledgeBundleResult> => {
    const promotion = KnowledgePromotionSchema.parse(input.promotion);
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
    }
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
