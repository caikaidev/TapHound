import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { DisplayViewport } from "../../domain/geometry.js";
import type { LayoutElement } from "../../domain/layout.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type { UiSnapshot } from "../../ports/ui-snapshot.js";

export interface UiSnapshotTiming {
  now?: (() => Date) | undefined;
  createObservationId?: (() => string) | undefined;
}

export function snapshotFromCapture(input: {
  startedAt: number;
  roots: readonly LayoutElement[];
  backend: UiBackendDescriptor;
  viewport: DisplayViewport;
  timing: UiSnapshotTiming;
}): UiSnapshot {
  return {
    observationId: (input.timing.createObservationId ?? randomUUID)(),
    capturedAt: (input.timing.now ?? ((): Date => new Date()))().toISOString(),
    durationMs: performance.now() - input.startedAt,
    backend: input.backend,
    viewport: input.viewport,
    roots: input.roots
  };
}
