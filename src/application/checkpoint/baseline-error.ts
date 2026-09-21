import type { FailureCode } from "../../domain/failure.js";

export class BaselineError extends Error {
  public constructor(
    public readonly code: Extract<
      FailureCode,
      "BASELINE_INCOMPARABLE" | "BASELINE_EMPTY"
    >,
    message: string
  ) {
    super(message);
    this.name = "BaselineError";
  }
}
