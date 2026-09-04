import type { UiBackendDescriptor } from "../../domain/ui-backend.js";

export type UiSnapshotErrorCode =
  | "UI_BACKEND_UNAVAILABLE"
  | "UI_SNAPSHOT_FAILED"
  | "UI_SNAPSHOT_INVALID";

export class UiSnapshotError extends Error {
  public override readonly name = "UiSnapshotError";
  public readonly terminal: boolean;

  public constructor(
    public readonly code: UiSnapshotErrorCode,
    public readonly backendId: UiBackendDescriptor["id"],
    message: string,
    options?: ErrorOptions & { terminal?: boolean | undefined }
  ) {
    super(message, options);
    this.terminal = options?.terminal ?? false;
  }
}
