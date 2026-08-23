import type {
  PendingConfirmation
} from "../domain/generation.js";
import type { Expectation } from "../domain/journey.js";
import type { LayoutElement } from "../domain/layout.js";
import type {
  ProposalBinding,
  ProposedStep
} from "../domain/proposed-step.js";

export type ManualAction = Exclude<ProposedStep["action"], "bridge">;

export interface ManualProposalInput {
  action: ManualAction;
  binding: ProposalBinding;
  before: string;
  expect?: Expectation | undefined;
  layout: readonly LayoutElement[];
}

export interface GenerationPromptPort {
  confirm: (
    challenge: PendingConfirmation,
    signal?: AbortSignal
  ) => Promise<boolean>;
  buildManualProposal: (
    input: ManualProposalInput,
    signal?: AbortSignal
  ) => Promise<ProposedStep>;
}

export class GenerationPromptCancelledError extends Error {
  public override readonly name = "GenerationPromptCancelledError";

  public constructor() {
    super("Generation prompt was cancelled");
  }
}
