import type {
  PendingConfirmation
} from "../domain/generation.js";
import type { Expectation } from "../domain/journey.js";
import type { LayoutElement } from "../domain/layout.js";
import type {
  ProposalBinding,
  ProposedStep
} from "../domain/proposed-step.js";

export interface ManualProposalInput {
  action: ProposedStep["action"];
  binding: ProposalBinding;
  before: string;
  expect?: Expectation | undefined;
  layout: readonly LayoutElement[];
}

export interface GenerationPromptPort {
  confirm: (challenge: PendingConfirmation) => Promise<boolean>;
  buildManualProposal: (
    input: ManualProposalInput
  ) => Promise<ProposedStep>;
}
