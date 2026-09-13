import {
  ContractReviewSchema,
  ContractVerdictViewSchema,
  type ContractReview,
  type ContractReviewInput,
  type ContractVerdictView
} from "../../domain/contract.js";

export interface ContractReviewMergeDependencies {
  now: () => Date;
}

export interface ContractReviewMergeResult {
  view: ContractVerdictView;
  applied: boolean;
}

const IMMUTABLE_VERDICTS: ReadonlySet<ContractVerdictView["verdict"]> = new Set([
  "fail",
  "invalid"
]);

/**
 * Applies reviewer findings on top of a deterministic Verdict view.
 *
 * Source-of-Truth enforcement (docs/source-of-truth.md):
 * - a lower-trust layer (semantic / multimodal reviewer) may escalate a
 *   successful or uncertain result into `needsReview`;
 * - it must never rewrite a deterministic `fail` or `invalid` back to
 *   success; those stay immutable and the review is recorded as not applied.
 */
export class ContractReviewMerger {
  public constructor(
    private readonly dependencies: ContractReviewMergeDependencies
  ) {}

  public readonly merge = (input: {
    view: ContractVerdictView;
    review: ContractReviewInput;
  }): Promise<ContractReviewMergeResult> => {
    const { view, review } = input;
    const immutable = IMMUTABLE_VERDICTS.has(view.verdict);
    const applied = !immutable;
    const previousFindings = view.review?.findings ?? [];
    const record: ContractReview = ContractReviewSchema.parse({
      version: 1,
      source: review.source,
      ...(review.model === undefined ? {} : { model: review.model }),
      ...(review.promptVersion === undefined
        ? {}
        : { promptVersion: review.promptVersion }),
      findings: [...previousFindings, ...review.findings],
      appliedAt: new Date(this.dependencies.now()).toISOString(),
      applied,
      baseVerdict: view.verdict,
      baseReason: view.reason
    });

    const merged: ContractVerdictView = ContractVerdictViewSchema.parse({
      ...view,
      ...(applied
        ? {
            verdict: "needsReview" as const,
            reason: "REVIEW_FINDINGS" as const,
            message: `Reviewer ${review.source} found ${
              String(record.findings.length)
            } finding(s) requiring human review`
          }
        : {}),
      review: record
    });
    return Promise.resolve({ view: merged, applied });
  };
}