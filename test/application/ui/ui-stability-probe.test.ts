import { describe, expect, it, vi } from "vitest";

import { uiStabilityProbe } from "../../../src/application/ui/ui-stability-probe.js";
import type { UiStabilityProbe } from "../../../src/ports/ui-stability.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

function probe(): UiStabilityProbe & {
  sample: ReturnType<typeof vi.fn<UiStabilityProbe["sample"]>>;
  reset: ReturnType<typeof vi.fn<UiStabilityProbe["reset"]>>;
} {
  return {
    sample: vi.fn<UiStabilityProbe["sample"]>(() => Promise.resolve([])),
    reset: vi.fn<UiStabilityProbe["reset"]>()
  };
}

describe("uiStabilityProbe", () => {
  it("uses the runtime probe when the provider cannot sample", () => {
    const fallback = probe();
    expect(uiStabilityProbe(uiSnapshotProvider(), fallback)).toBe(fallback);
    expect(uiStabilityProbe(
      Object.assign(uiSnapshotProvider(), { ...probe(), supportsStability: false }),
      fallback
    )).toBe(fallback);
  });

  it("sends frame stats to the runtime probe and structural samples to the provider", async () => {
    const fallback = probe();
    const structural = probe();
    const composed = uiStabilityProbe(
      Object.assign(uiSnapshotProvider(), structural),
      fallback
    );

    await composed.sample({
      deviceSerial: "emulator-5554",
      packageName: "com.example.app",
      stabilityBackend: "frameStats"
    });
    await composed.sample({ deviceSerial: "emulator-5554", stabilityBackend: "uiautomator" });
    await composed.sample({ deviceSerial: "emulator-5554" });
    composed.reset();

    expect(fallback.sample).toHaveBeenCalledOnce();
    expect(fallback.sample).toHaveBeenCalledWith(
      expect.objectContaining({ stabilityBackend: "frameStats" })
    );
    expect(structural.sample).toHaveBeenCalledTimes(2);
    expect(fallback.reset).toHaveBeenCalledOnce();
    expect(structural.reset).toHaveBeenCalledOnce();
  });
});
