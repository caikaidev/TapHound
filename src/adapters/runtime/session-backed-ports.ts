import type { Point } from "../../domain/geometry.js";
import type { AnnotatedScreenResolverPort } from "../../ports/annotated-screen-resolver.js";
import type { CommandResult } from "../../ports/process-runner.js";
import type {
  RuntimeBackend,
  RuntimeSession
} from "../../ports/runtime-backend.js";
import type { ScreenshotOptions, ScreenshotPort } from "../../ports/screenshot.js";
import type {
  OpenUiSnapshotProviderOptions,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import type {
  UiStabilityProbe,
  UiStabilitySampleOptions,
  UiStabilitySampleResult
} from "../../ports/ui-stability.js";

export type RuntimeSessionOpener = Pick<RuntimeBackend, "openSession">;

export class SessionBackedScreenshotAdapter implements ScreenshotPort {
  public constructor(private readonly sessions: RuntimeSessionOpener) {}

  public capture(options: ScreenshotOptions): Promise<CommandResult> {
    return this.sessions.openSession({
      deviceSerial: options.deviceSerial,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }).then((session): Promise<CommandResult> => (
      session.captureScreenshot({
        outputPath: options.outputPath,
        ...(options.annotate === undefined ? {} : { annotate: options.annotate }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
      })
    ));
  }
}

export class SessionBackedUiStabilityAdapter implements UiStabilityProbe {
  private readonly resolved = new Map<string, RuntimeSession>();

  public constructor(private readonly sessions: RuntimeSessionOpener) {}

  public reset(): void {
    for (const session of this.resolved.values()) {
      session.uiStability.reset();
    }
  }

  public sample(
    options: UiStabilitySampleOptions
  ): Promise<UiStabilitySampleResult> {
    return this.sessions.openSession({
      deviceSerial: options.deviceSerial,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }).then((session): Promise<UiStabilitySampleResult> => {
      this.resolved.set(options.deviceSerial, session);
      return session.uiStability.sample(options);
    });
  }
}

export class SessionBackedUiSnapshotProviderFactory
  implements UiSnapshotProviderFactory {
  public constructor(private readonly sessions: RuntimeSessionOpener) {}

  public open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    return this.sessions.openSession({
      deviceSerial: options.deviceSerial,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }).then((session): Promise<UiSnapshotProvider> => (
      session.openUiSnapshots({
        timeoutMs: options.timeoutMs,
        ...(options.backend === undefined ? {} : { backend: options.backend }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    ));
  }
}

export class FailClosedAnnotatedScreenResolver
  implements AnnotatedScreenResolverPort {
  public constructor(private readonly backendId: string) {}

  public resolve(): Promise<Point> {
    return Promise.reject(new Error(
      `Runtime backend "${this.backendId}" does not support annotated screens`
    ));
  }
}
