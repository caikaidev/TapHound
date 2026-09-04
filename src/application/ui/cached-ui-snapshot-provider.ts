import type {
  CaptureUiSnapshotOptions,
  UiSnapshot,
  UiSnapshotProvider,
  UiSnapshotProviderFactory,
  OpenUiSnapshotProviderOptions
} from "../../ports/ui-snapshot.js";

type InvalidationReason = Parameters<
  NonNullable<UiSnapshotProvider["invalidate"]>
>[0];

interface CachedObservation {
  epoch: number;
  storedAtMs: number;
  snapshot: UiSnapshot;
}

export class CachedUiSnapshotProviderFactory implements
  UiSnapshotProviderFactory {
  public constructor(
    private readonly source: UiSnapshotProviderFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 300
  ) {}

  public async open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    const provider = await this.source.open(options);
    return options.cacheEnabled === false
      ? provider
      : new CachedUiSnapshotProvider(provider, this.now, this.ttlMs);
  }
}

export class CachedUiSnapshotProvider implements UiSnapshotProvider {
  public readonly descriptor;
  private mutationEpoch = 0;
  private cached: CachedObservation | undefined;
  private inFlight: { epoch: number; promise: Promise<UiSnapshot> } | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private hits = 0;
  private misses = 0;
  private capturesSaved = 0;

  public constructor(
    private readonly source: UiSnapshotProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 300
  ) {
    this.descriptor = source.descriptor;
  }

  public capture(options: CaptureUiSnapshotOptions): Promise<UiSnapshot> {
    if (this.closed) {
      return Promise.reject(new Error("UI snapshot provider is closed"));
    }
    const freshness = options.freshness ?? "forceFresh";
    const epoch = this.mutationEpoch;
    if (freshness === "sameMutationEpoch") {
      if (
        this.cached?.epoch === epoch
        && this.now() - this.cached.storedAtMs <= this.ttlMs
      ) {
        this.hits += 1;
        this.capturesSaved += 1;
        return Promise.resolve(this.cached.snapshot);
      }
      if (this.inFlight?.epoch === epoch) {
        this.hits += 1;
        this.capturesSaved += 1;
        return this.inFlight.promise;
      }
    }
    this.misses += 1;
    const promise = this.source.capture(options).then((snapshot) => {
      if (!this.closed && this.mutationEpoch === epoch) {
        this.cached = { epoch, storedAtMs: this.now(), snapshot };
      }
      return snapshot;
    }).finally(() => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
      }
    });
    if (freshness === "sameMutationEpoch") {
      this.inFlight = { epoch, promise };
    }
    return promise;
  }

  public invalidate(reason: InvalidationReason): void {
    void reason;
    this.mutationEpoch += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.invalidate("providerClosed");
    this.closePromise = this.source.close();
    return this.closePromise;
  }

  public cacheTelemetry(): {
    hits: number;
    misses: number;
    stale: number;
    relearns: number;
    capturesSaved: number;
    validationDurationMs: number;
  } {
    return {
      hits: this.hits,
      misses: this.misses,
      stale: 0,
      relearns: 0,
      capturesSaved: this.capturesSaved,
      validationDurationMs: 0
    };
  }
}
