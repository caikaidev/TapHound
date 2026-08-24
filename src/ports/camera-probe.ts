export interface CameraProbeResult {
  packageName: string;
  activityName: string;
  shutterResourceId: string;
  shutterContentDescription?: string | undefined;
  confirmResourceId?: string | undefined;
  confirmContentDescription?: string | undefined;
}

export interface CameraProbeInput {
  deviceSerial: string;
  signal?: AbortSignal | undefined;
}

export interface CameraProbePort {
  probe: (input: CameraProbeInput) => Promise<CameraProbeResult>;
}
