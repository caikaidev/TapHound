import type { DisplayViewport } from "../domain/geometry.js";
import type { LayoutElement } from "../domain/layout.js";
import type {
  UiBackendDescriptor,
  UiBackendSelection
} from "../domain/ui-backend.js";
import type { UiCacheTelemetry } from "../domain/ui-cache.js";

export interface OpenUiSnapshotProviderOptions {
  deviceSerial: string;
  timeoutMs: number;
  backend?: UiBackendSelection | undefined;
  cacheEnabled?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface CaptureUiSnapshotOptions {
  reason: "observe" | "locate" | "expect" | "idle" | "evidence";
  timeoutMs: number;
  freshness?: "forceFresh" | "sameMutationEpoch" | undefined;
  signal?: AbortSignal | undefined;
}

export interface UiSnapshot {
  observationId: string;
  capturedAt: string;
  durationMs: number;
  backend: UiBackendDescriptor;
  viewport: DisplayViewport;
  roots: readonly LayoutElement[];
}

export interface UiSnapshotProvider {
  readonly descriptor: UiBackendDescriptor;
  capture: (options: CaptureUiSnapshotOptions) => Promise<UiSnapshot>;
  close: () => Promise<void>;
  cacheTelemetry?: (() => UiCacheTelemetry) | undefined;
  invalidate?: ((reason:
    | "beforeAction"
    | "foregroundChanged"
    | "processChanged"
    | "windowChanged"
    | "rotationChanged"
    | "providerClosed"
  ) => void) | undefined;
}

export interface UiSnapshotProviderFactory {
  open: (
    options: OpenUiSnapshotProviderOptions
  ) => Promise<UiSnapshotProvider>;
}
