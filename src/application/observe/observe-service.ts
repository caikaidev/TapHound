import {
  ObserveReportSchema,
  type ObserveReport
} from "../../domain/observation.js";
import type { CommandResult } from "../../ports/process-runner.js";
import type { RuntimeSessionOpener } from "../../ports/runtime-backend.js";
import { runtimeCapabilityMissing } from "../../ports/runtime-capability.js";
import type {
  UiSnapshot,
  UiSnapshotProvider
} from "../../ports/ui-snapshot.js";
import type { UiBackendSelection } from "../../domain/ui-backend.js";
import { closeUiSnapshotProvider } from "../ui/ui-snapshot-lifecycle.js";

export interface ObserveInput {
  packageName: string;
  deviceSerial: string;
  logcatLines?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ObserveDependencies {
  sessions: RuntimeSessionOpener;
  layoutTimeoutMs: number;
  backend?: UiBackendSelection | undefined;
  cacheEnabled?: boolean | undefined;
}

function failedCommand(result: CommandResult): boolean {
  return result.exitCode !== 0
    || result.spawnError !== undefined
    || result.timedOut
    || result.cancelled;
}

function splitLogcat(stdout: string): string[] {
  const lines = stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export class ObserveService {
  public constructor(
    private readonly dependencies: ObserveDependencies
  ) {}

  public async observe(input: ObserveInput): Promise<ObserveReport> {
    const { packageName, deviceSerial, logcatLines, signal } = input;
    const session = await this.dependencies.sessions.openSession({
      deviceSerial,
      ...(signal === undefined ? {} : { signal })
    });
    const app = {
      packageName,
      ...(signal === undefined ? {} : { signal })
    };

    if (session.foregroundComponent === undefined) {
      throw runtimeCapabilityMissing(
        session.descriptor.id,
        "foregroundComponent"
      );
    }
    const foreground = await session.foregroundComponent(app);

    const activity = foreground.packageName === packageName
      ? foreground.activity
      : undefined;

    const uiSnapshotProvider = await session.openUiSnapshots({
      timeoutMs: this.dependencies.layoutTimeoutMs,
      ...(this.dependencies.backend === undefined
        ? {}
        : { backend: this.dependencies.backend }),
      ...(this.dependencies.cacheEnabled === undefined
        ? {}
        : { cacheEnabled: this.dependencies.cacheEnabled }),
      ...(signal === undefined ? {} : { signal })
    });
    let uiCache: ReturnType<NonNullable<
      UiSnapshotProvider["cacheTelemetry"]
    >> | undefined;
    const uiSnapshot = await (async (): Promise<UiSnapshot> => {
      try {
        return await uiSnapshotProvider.capture({
          reason: "observe",
          timeoutMs: this.dependencies.layoutTimeoutMs,
          ...(signal === undefined ? {} : { signal })
        });
      } finally {
        uiCache = uiSnapshotProvider.cacheTelemetry?.();
        await closeUiSnapshotProvider(uiSnapshotProvider);
      }
    })();

    let logcat: string[] | undefined;
    if (logcatLines !== undefined && logcatLines > 0) {
      if (session.dumpLogcat === undefined) {
        throw runtimeCapabilityMissing(
          session.descriptor.id,
          "dumpLogcat"
        );
      }
      const result = await session.dumpLogcat({
        maxLines: logcatLines,
        ...(signal === undefined ? {} : { signal })
      });
      if (failedCommand(result)) {
        throw new Error(
          result.stderr.trim()
            || result.spawnError
            || "Logcat dump failed"
        );
      }
      logcat = splitLogcat(result.stdout);
    }

    return ObserveReportSchema.parse({
      deviceSerial,
      packageName,
      ...(activity === undefined ? {} : { activity }),
      foreground,
      uiBackend: uiSnapshot.backend,
      uiCaptureDurationMs: uiSnapshot.durationMs,
      ...(uiCache === undefined ? {} : { uiCache }),
      layout: uiSnapshot.roots,
      ...(logcat === undefined ? {} : { logcat })
    });
  }
}
