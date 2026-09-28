import { z } from "zod";

export const VERIFY_RECEIPT_FILE = "receipt.json";

const DigestSchema = z.string().regex(/^[a-f\d]{64}$/);

/**
 * A process receipt that `verify --journey` writes beside the report it
 * published. `argv` is the normalized invocation TapHound actually ran:
 * absolute project and Journey paths and the selected device serial, so a
 * Workflow checker never has to trust a hand-written record.
 */
export const VerifyReceiptSchema = z.strictObject({
  version: z.literal(1),
  argv: z.array(z.string().min(1)).min(1),
  exitCode: z.number().int().min(0).max(4),
  journeySha256: DigestSchema,
  reportPath: z.string().min(1),
  reportSha256: DigestSchema
});

export type VerifyReceipt = z.infer<typeof VerifyReceiptSchema>;
