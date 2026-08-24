import type { CameraProbeResult } from "./camera-probe.js";

export class AlignPromptCancelledError extends Error {
  public override readonly name = "AlignPromptCancelledError";

  public constructor() {
    super("Align prompt was cancelled");
  }
}

export interface AlignPromptPort {
  confirmWrite: (input: {
    values: CameraProbeResult;
    targetPath: string;
  }) => Promise<boolean>;
}
