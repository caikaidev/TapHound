import type { Clock } from "../../src/ports/clock.js";

export class FakeClock implements Clock {
  public currentTime = 0;
  public readonly sleeps: number[] = [];
  public onSleep?: (() => void) | undefined;

  public readonly now = (): number => this.currentTime;

  public readonly sleep = (
    durationMs: number,
    signal?: AbortSignal
  ): Promise<void> => {
    this.sleeps.push(durationMs);
    this.onSleep?.();
    if (signal?.aborted === true) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Operation aborted")
      );
    }
    this.currentTime += durationMs;
    return Promise.resolve();
  };
}
