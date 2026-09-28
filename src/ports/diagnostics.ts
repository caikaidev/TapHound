import type { CommandEvent } from "../domain/diagnostics.js";
import type { UiBackendId } from "../domain/ui-backend.js";

/** Receives UI backend timing facts; never error text. */
export interface UiCaptureObserver {
  captured: (backend: UiBackendId, durationMs: number, error?: unknown) => void;
  sessionRecovered: (backend: UiBackendId, succeeded: boolean) => void;
}

/** The local, Git-ignored diagnostics journal of one host project. */
export interface DiagnosticsJournal {
  append: (projectRoot: string, event: CommandEvent) => Promise<void>;
  /** Raw journal lines, oldest first, including the rotated file. */
  readLines: (projectRoot: string) => Promise<readonly string[]>;
  /** A per-project random salt that never leaves the host. */
  salt: (projectRoot: string) => Promise<Buffer>;
}
