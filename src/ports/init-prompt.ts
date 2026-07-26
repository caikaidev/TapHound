import type { AgentId } from "../domain/init.js";

export interface InitPromptPort {
  selectAgents: () => Promise<AgentId[]>;
}

export class InitPromptCancelledError extends Error {
  public override readonly name = "InitPromptCancelledError";

  public constructor() {
    super("Init prompt was cancelled");
  }
}
