import { describe, expect, it, vi } from "vitest";

import {
  CachedUiSnapshotProvider
} from "../../../src/application/ui/cached-ui-snapshot-provider.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

describe("CachedUiSnapshotProvider", () => {
  it("single-flights concurrent reads in one mutation epoch", async () => {
    const source = uiSnapshotProvider();
    let release: (() => void) | undefined;
    vi.mocked(source.capture).mockImplementation(() => new Promise((resolve) => {
      release = (): void => {
        resolve({
        observationId: "shared",
        capturedAt: "2026-09-02T00:00:00.000Z",
        durationMs: 4,
        backend: source.descriptor,
        viewport: {
          width: 1080,
          height: 1920,
          rotation: 0,
          coordinateSpace: "physicalDisplayPixels"
        },
          roots: []
        });
      };
    }));
    const cached = new CachedUiSnapshotProvider(source, () => 100, 300);

    const left = cached.capture({
      reason: "locate",
      freshness: "sameMutationEpoch",
      timeoutMs: 1000
    });
    const right = cached.capture({
      reason: "expect",
      freshness: "sameMutationEpoch",
      timeoutMs: 1000
    });
    release?.();

    await expect(Promise.all([left, right])).resolves.toMatchObject([
      { observationId: "shared" },
      { observationId: "shared" }
    ]);
    expect(source.capture).toHaveBeenCalledOnce();
    expect(cached.cacheTelemetry()).toEqual({
      hits: 1,
      misses: 1,
      stale: 0,
      relearns: 0,
      capturesSaved: 1,
      validationDurationMs: 0
    });
  });

  it("forces authoritative reads and invalidates before every mutation", async () => {
    const source = uiSnapshotProvider();
    const cached = new CachedUiSnapshotProvider(source, () => 100, 300);
    const options = {
      reason: "locate" as const,
      freshness: "sameMutationEpoch" as const,
      timeoutMs: 1000
    };

    await cached.capture(options);
    await cached.capture(options);
    expect(source.capture).toHaveBeenCalledOnce();

    cached.invalidate("beforeAction");
    await cached.capture(options);
    await cached.capture({ ...options, freshness: "forceFresh" });
    expect(source.capture).toHaveBeenCalledTimes(3);
  });

  it("clears cached state and closes its source exactly once", async () => {
    const source = uiSnapshotProvider();
    const cached = new CachedUiSnapshotProvider(source, () => 100, 300);
    await cached.capture({
      reason: "locate",
      freshness: "sameMutationEpoch",
      timeoutMs: 1000
    });

    await cached.close();
    await cached.close();

    expect(source.close).toHaveBeenCalledOnce();
    await expect(cached.capture({
      reason: "locate",
      freshness: "sameMutationEpoch",
      timeoutMs: 1000
    })).rejects.toThrow(/closed/i);
  });
});
