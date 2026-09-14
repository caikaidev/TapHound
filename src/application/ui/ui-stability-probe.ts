import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";

export function uiStabilityProbe(
  provider: UiSnapshotProvider,
  fallback: UiStabilityProbe
): UiStabilityProbe {
  const withCapability = provider as UiSnapshotProvider & {
    supportsStability?: boolean;
    sample?: unknown;
    reset?: unknown;
  };
  return withCapability.supportsStability !== false
    && typeof withCapability.sample === "function"
    && typeof withCapability.reset === "function"
    ? (withCapability as unknown as UiStabilityProbe)
    : fallback;
}
