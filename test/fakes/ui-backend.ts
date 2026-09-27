import type { UiBackendDescriptor } from "../../src/domain/ui-backend.js";
import type { DisplayViewport } from "../../src/domain/geometry.js";

/** The UI backend bound by generation sessions and snapshots in tests. */
export const TEST_UI_BACKEND: UiBackendDescriptor = {
  id: "system-uiautomator",
  adapterVersion: "test-v1",
  configSha256: "0".repeat(64)
};

export const TEST_VIEWPORT: DisplayViewport = {
  width: 1080,
  height: 1920,
  rotation: 0,
  coordinateSpace: "physicalDisplayPixels"
};

/** UI observation fields every RuntimeSnapshot carries. */
export const TEST_SNAPSHOT_UI = {
  uiBackend: TEST_UI_BACKEND,
  uiObservationId: "test-observation",
  uiCaptureDurationMs: 1,
  viewport: TEST_VIEWPORT
};

/** The strict Replay policy every generation meta sidecar binds. */
export const TEST_REPLAY_POLICY = {
  generatedReplayPolicy: true,
  requireFocusedInput: true,
  idle: {
    strategy: "hybrid" as const,
    pollIntervalMs: 100,
    stablePolls: 2,
    timeoutMs: 5000
  }
};
