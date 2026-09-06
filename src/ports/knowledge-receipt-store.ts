import type { KnowledgeReceipt } from "../domain/knowledge-receipt.js";

export interface KnowledgeReceiptStore {
  write: (input: {
    projectRoot: string;
    receipt: KnowledgeReceipt;
  }) => Promise<string>;
  read: (input: {
    projectRoot: string;
    receiptId: string;
  }) => Promise<KnowledgeReceipt>;
  list: (projectRoot: string) => Promise<readonly KnowledgeReceipt[]>;
}
