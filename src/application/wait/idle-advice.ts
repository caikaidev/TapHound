import type { IdleResult } from "./idle-waiter.js";

export type IdleTimeoutResult = Extract<IdleResult, { status: "timeout" }>;

const SLOW_CAPTURE_BUDGET_RATIO = 0.8;

export function idleTimeoutAdvice(idle: IdleTimeoutResult): string {
  if (idle.frameActivityDetected) {
    return `frame activity never settled under idle.strategy "${idle.strategy}"; `
      + "if the screen animates continuously, set idle.strategy to "
      + "\"layoutDiff\" in .taphound/config.json";
  }
  if (idle.lastDiff.length > 0) {
    return "layout differences kept appearing (see lastDiff in the step "
      + "report); raise idle.timeoutMs in .taphound/config.json if the "
      + "change is expected to settle, or set idle.strategy to "
      + "\"layoutDiff\" if the screen animates continuously";
  }
  if (
    idle.durationMs > 0
    && idle.samplingDurationMs >= idle.durationMs * SLOW_CAPTURE_BUDGET_RATIO
  ) {
    return "UI snapshot captures consumed most of the idle budget; raise "
      + "idle.timeoutMs in .taphound/config.json so idle.stablePolls "
      + "consecutive polls fit, and raise ui.snapshotTimeoutMs if "
      + "individual dumps are slow";
  }
  return "no layout change was detected but the idle budget ended before "
    + "idle.stablePolls consecutive stable polls; raise idle.timeoutMs or "
    + "lower idle.stablePolls/pollIntervalMs in .taphound/config.json";
}

export function withIdleAdvice(
  message: string,
  idle: IdleTimeoutResult
): string {
  return `${message} (${idleTimeoutAdvice(idle)})`;
}
