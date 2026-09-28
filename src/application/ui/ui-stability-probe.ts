import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../../ports/ui-stability.js";

/**
 * A snapshot provider that samples stability itself (Appium) answers every
 * structural sample, but frame-stat samples still go to the runtime probe:
 * the provider only knows page sources, so it would answer a cheap
 * `dumpsys gfxinfo` request with a full hierarchy capture.
 */
export function uiStabilityProbe(
  provider: UiSnapshotProvider,
  fallback: UiStabilityProbe
): UiStabilityProbe {
  const withCapability = provider as UiSnapshotProvider & {
    supportsStability?: boolean;
    sample?: unknown;
    reset?: unknown;
  };
  if (
    withCapability.supportsStability === false
    || typeof withCapability.sample !== "function"
    || typeof withCapability.reset !== "function"
  ) {
    return fallback;
  }
  const structural = withCapability as unknown as UiStabilityProbe;
  return {
    reset: (): void => {
      structural.reset();
      fallback.reset();
    },
    sample: (options) => (
      options.stabilityBackend === "frameStats"
        ? fallback.sample(options)
        : structural.sample(options)
    )
  };
}
