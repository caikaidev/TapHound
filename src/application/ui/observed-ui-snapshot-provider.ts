import type { UiCacheTelemetry } from "../../domain/ui-cache.js";
import type { UiCaptureObserver } from "../../ports/diagnostics.js";
import type {
  OpenUiSnapshotProviderOptions,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import type {
  UiStabilityProbe,
  UiStabilitySampleResult
} from "../../ports/ui-stability.js";

type ProbeLike = UiSnapshotProvider & Partial<UiStabilityProbe>;

/**
 * Reports the duration and outcome of every UI backend read (captures and
 * stability samples) to an observer. It sits under the snapshot cache, so a
 * cache hit is not counted as a device read.
 */
export class ObservedUiSnapshotProviderFactory implements UiSnapshotProviderFactory {
  public constructor(
    private readonly source: UiSnapshotProviderFactory,
    private readonly observer: UiCaptureObserver,
    private readonly now: () => number
  ) {}

  public async open(options: OpenUiSnapshotProviderOptions): Promise<UiSnapshotProvider> {
    return observeProvider(await this.source.open(options), this.observer, this.now);
  }
}

export function observeProvider(
  provider: UiSnapshotProvider,
  observer: UiCaptureObserver,
  now: () => number
): UiSnapshotProvider {
  const source = provider as ProbeLike;
  const timed = async <T>(read: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      const value = await read();
      observer.captured(source.descriptor.id, now() - startedAt);
      return value;
    } catch (error) {
      observer.captured(source.descriptor.id, now() - startedAt, error);
      throw error;
    }
  };
  const cacheTelemetry = source.cacheTelemetry;
  const invalidate = source.invalidate;
  const observed: ProbeLike = {
    descriptor: source.descriptor,
    capture: (options) => timed(() => source.capture(options)),
    close: () => source.close(),
    ...(cacheTelemetry === undefined
      ? {}
      : { cacheTelemetry: (): UiCacheTelemetry => cacheTelemetry.call(source) }),
    ...(invalidate === undefined
      ? {}
      : {
          invalidate: (reason): void => {
            invalidate.call(source, reason);
          }
        })
  };
  const sample = source.sample;
  const reset = source.reset;
  if (typeof sample === "function" && typeof reset === "function") {
    observed.sample = (options): Promise<UiStabilitySampleResult> => timed(
      () => sample.call(source, options)
    );
    observed.reset = (): void => {
      reset.call(source);
    };
  }
  const withSupport = source as ProbeLike & { supportsStability?: boolean };
  if (withSupport.supportsStability !== undefined) {
    Object.defineProperty(observed, "supportsStability", {
      value: withSupport.supportsStability,
      enumerable: true
    });
  }
  return observed;
}
