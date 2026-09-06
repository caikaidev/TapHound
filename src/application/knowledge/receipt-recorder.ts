import {
  KnowledgeReceiptSchema,
  type KnowledgeReceipt
} from "../../domain/knowledge-receipt.js";
import type {
  KnowledgeReceiptStore
} from "../../ports/knowledge-receipt-store.js";

export class KnowledgeReceiptRecorder {
  public constructor(
    private readonly store: Pick<KnowledgeReceiptStore, "write">
  ) {}

  public readonly record = async (input: {
    projectRoot: string;
    receipt: KnowledgeReceipt;
  }): Promise<string> => this.store.write({
    projectRoot: input.projectRoot,
    receipt: KnowledgeReceiptSchema.parse(input.receipt)
  });
}
