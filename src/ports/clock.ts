export interface Clock {
  now: () => number;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}
