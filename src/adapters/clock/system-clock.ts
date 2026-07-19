import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type { Clock } from "../../ports/clock.js";

export class SystemClock implements Clock {
  public readonly now = (): number => performance.now();

  public readonly sleep = (
    durationMs: number,
    signal?: AbortSignal
  ): Promise<void> => {
    if (signal?.aborted === true) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Operation aborted")
      );
    }
    return delay(durationMs, undefined, { signal });
  };
}
