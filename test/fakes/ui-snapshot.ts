import { vi } from "vitest";

import type { LayoutElement } from "../../src/domain/layout.js";
import type { DisplayViewport } from "../../src/domain/geometry.js";
import type {
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../src/ports/ui-snapshot.js";

export function uiSnapshotProvider(
  roots: readonly LayoutElement[] = []
): UiSnapshotProvider {
  return {
    descriptor: {
      id: "system-uiautomator",
      adapterVersion: "test-v1",
      configSha256: "0".repeat(64)
    },
    capture: vi.fn(() => Promise.resolve({
      observationId: "test-observation",
      capturedAt: "2026-08-30T08:00:00.000Z",
      durationMs: 1,
      backend: {
        id: "system-uiautomator" as const,
        adapterVersion: "test-v1",
        configSha256: "0".repeat(64)
      },
      viewport: {
        width: 1080,
        height: 1920,
        rotation: 0 as const,
        coordinateSpace: "physicalDisplayPixels" as const
      },
      roots
    })),
    close: vi.fn(() => Promise.resolve())
  };
}

export function uiSnapshotFactory(
  provider: UiSnapshotProvider
): UiSnapshotProviderFactory {
  return {
    open: vi.fn(() => Promise.resolve(provider))
  };
}

export function uiSnapshotProviderFromLayout(
  layout: (options: {
    deviceSerial: string;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  }) => Promise<readonly LayoutElement[]>,
  deviceSerial = "emulator-5554",
  viewport: DisplayViewport = {
    width: 1080,
    height: 1920,
    rotation: 0,
    coordinateSpace: "physicalDisplayPixels"
  }
): UiSnapshotProvider {
  const provider = uiSnapshotProvider();
  vi.mocked(provider.capture).mockImplementation(async (options) => ({
    observationId: "test-observation",
    capturedAt: "2026-08-30T08:00:00.000Z",
    durationMs: 1,
    backend: provider.descriptor,
    viewport,
    roots: await layout({
      deviceSerial,
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
  }));
  return provider;
}
