import {
  UI_CAPTURE_LATENCY_BUCKETS_MS,
  type UiBackendTelemetry,
  type UiCaptureFailureKind
} from "../../domain/diagnostics.js";
import type { UiBackendId } from "../../domain/ui-backend.js";
import type { UiCaptureObserver } from "../../ports/diagnostics.js";

/**
 * Classifies a capture failure from its type and status only, walking the
 * cause chain. The message is read solely to spot a timeout and is never kept.
 */
export function classifyCaptureFailure(error: unknown): UiCaptureFailureKind {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as { name?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "TimeoutError") return "timeout";
    if (record.name === "AbortError") return "cancelled";
    if (typeof record.status === "number") {
      if (record.status >= 500) return "http5xx";
      if (record.status >= 400) return "http4xx";
    }
    if (typeof record.message === "string" && /timed? ?out/i.test(record.message)) {
      return "timeout";
    }
    current = record.cause;
  }
  return "error";
}

function emptyTelemetry(backend: UiBackendId): UiBackendTelemetry {
  return {
    backend,
    captures: 0,
    failures: { timeout: 0, cancelled: 0, http4xx: 0, http5xx: 0, error: 0 },
    totalMs: 0,
    maxMs: 0,
    latencyBuckets: new Array<number>(UI_CAPTURE_LATENCY_BUCKETS_MS.length + 1).fill(0),
    sessionRecoveries: 0,
    sessionRecoveryFailures: 0
  };
}

/** Aggregates UI backend captures for one CLI invocation. */
export class UiCaptureTelemetry implements UiCaptureObserver {
  private readonly backends = new Map<UiBackendId, UiBackendTelemetry>();

  public captured(backend: UiBackendId, durationMs: number, error?: unknown): void {
    const entry = this.entry(backend);
    const duration = Math.max(0, durationMs);
    entry.captures += 1;
    entry.totalMs += duration;
    entry.maxMs = Math.max(entry.maxMs, duration);
    const bucket = UI_CAPTURE_LATENCY_BUCKETS_MS.findIndex((limit) => duration < limit);
    const index = bucket === -1 ? UI_CAPTURE_LATENCY_BUCKETS_MS.length : bucket;
    entry.latencyBuckets[index] = (entry.latencyBuckets[index] ?? 0) + 1;
    if (error !== undefined) {
      entry.failures[classifyCaptureFailure(error)] += 1;
    }
  }

  public sessionRecovered(backend: UiBackendId, succeeded: boolean): void {
    const entry = this.entry(backend);
    if (succeeded) {
      entry.sessionRecoveries += 1;
    } else {
      entry.sessionRecoveryFailures += 1;
    }
  }

  public summary(): UiBackendTelemetry[] {
    return [...this.backends.values()].map((entry) => ({
      ...entry,
      totalMs: Math.round(entry.totalMs),
      maxMs: Math.round(entry.maxMs),
      failures: { ...entry.failures },
      latencyBuckets: [...entry.latencyBuckets]
    }));
  }

  private entry(backend: UiBackendId): UiBackendTelemetry {
    let entry = this.backends.get(backend);
    if (entry === undefined) {
      entry = emptyTelemetry(backend);
      this.backends.set(backend, entry);
    }
    return entry;
  }
}
