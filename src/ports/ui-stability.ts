import type { LayoutElement } from "../domain/layout.js";

export interface UiStabilitySampleOptions {
  deviceSerial: string;
  packageName?: string | undefined;
  stabilityBackend?: "frameStats" | "uiautomator" | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface UiStabilityObservation {
  changes: readonly unknown[];
  layout?: readonly LayoutElement[] | undefined;
  backend?: "uiautomator" | "androidCli" | "gfxFrameStats" | undefined;
  durationMs?: number | undefined;
}

export type UiStabilitySampleResult =
  | readonly unknown[]
  | UiStabilityObservation;

export interface UiStabilityProbe {
  reset: () => void;
  sample: (
    options: UiStabilitySampleOptions
  ) => Promise<UiStabilitySampleResult>;
}
