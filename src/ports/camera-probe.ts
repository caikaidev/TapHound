import type { FailureCode } from "../domain/failure.js";

export type CameraProbeFailureCode = Extract<
  FailureCode,
  `ALIGN_CAMERA_${string}` | `ALIGN_SHUTTER_${string}` | `ALIGN_CONFIRM_${string}`
>;

export class CameraProbeError extends Error {
  public override readonly name = "CameraProbeError";

  public constructor(
    public readonly code: CameraProbeFailureCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export interface CameraProbeResult {
  packageName: string;
  activityName: string;
  shutterResourceId: string;
  shutterContentDescription?: string | undefined;
  confirmResourceId?: string | undefined;
  confirmContentDescription?: string | undefined;
  confirmActivityName?: string | undefined;
}

export interface CameraProbeInput {
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

export interface CameraProbePort {
  probe: (input: CameraProbeInput) => Promise<CameraProbeResult>;
}
