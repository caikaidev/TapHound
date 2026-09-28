import { describe, expect, it, vi } from "vitest";

import { UiCaptureTelemetry } from "../../../src/application/diagnostics/ui-capture-telemetry.js";
import {
  ObservedUiSnapshotProviderFactory,
  observeProvider
} from "../../../src/application/ui/observed-ui-snapshot-provider.js";
import type { UiSnapshotProvider } from "../../../src/ports/ui-snapshot.js";
import type { UiStabilityProbe } from "../../../src/ports/ui-stability.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

function clock(...times: number[]): () => number {
  return () => times.shift() ?? 0;
}

describe("observeProvider", () => {
  it("reports capture durations and failures to the observer", async () => {
    const provider = uiSnapshotProvider();
    vi.mocked(provider.capture).mockRejectedValueOnce(new DOMException("t", "TimeoutError"));
    const observer = { captured: vi.fn(), sessionRecovered: vi.fn() };
    const observed = observeProvider(provider, observer, clock(0, 40, 100, 1300));

    await expect(observed.capture({ reason: "locate", timeoutMs: 1000 })).rejects.toThrow();
    await observed.capture({ reason: "locate", timeoutMs: 1000 });

    expect(observer.captured.mock.calls).toEqual([
      ["system-uiautomator", 40, expect.any(DOMException)],
      ["system-uiautomator", 1200]
    ]);
  });

  it("keeps stability sampling only when the source supports it", async () => {
    const plain = observeProvider(uiSnapshotProvider(), new UiCaptureTelemetry(), clock());
    expect("sample" in plain).toBe(false);

    const probe = {
      sample: vi.fn<UiStabilityProbe["sample"]>(() => Promise.resolve([])),
      reset: vi.fn(),
      supportsStability: true
    };
    const source: UiSnapshotProvider = Object.assign(uiSnapshotProvider(), probe);
    const telemetry = new UiCaptureTelemetry();
    const observed = observeProvider(source, telemetry, clock(0, 700)) as UiSnapshotProvider
      & UiStabilityProbe & { supportsStability?: boolean };

    await observed.sample({ deviceSerial: "emulator-5554" });
    observed.reset();

    expect(observed.supportsStability).toBe(true);
    expect(probe.sample).toHaveBeenCalledOnce();
    expect(probe.reset).toHaveBeenCalledOnce();
    expect(telemetry.summary()[0]).toMatchObject({ captures: 1, totalMs: 700 });
  });

  it("wraps every provider a factory opens", async () => {
    const provider = uiSnapshotProvider();
    const telemetry = new UiCaptureTelemetry();
    const factory = new ObservedUiSnapshotProviderFactory(
      { open: vi.fn(() => Promise.resolve(provider)) },
      telemetry,
      clock(0, 10)
    );

    const opened = await factory.open({ deviceSerial: "emulator-5554", timeoutMs: 1000 });
    await opened.capture({ reason: "observe", timeoutMs: 1000 });
    await opened.close();

    expect(telemetry.summary()[0]).toMatchObject({ captures: 1, totalMs: 10 });
    expect(provider.close).toHaveBeenCalledOnce();
  });
});
