import { z } from "zod";

import {
  GenerationSessionIdSchema,
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import { LayoutElementSchema } from "../../domain/layout.js";
import {
  RuntimeSnapshotSchema,
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../domain/runtime-snapshot.js";
import type { AdbPort } from "../../ports/adb.js";
import type { AndroidCliPort } from "../../ports/android-cli.js";
import type {
  GenerationSessionStore
} from "../../ports/generation-session-store.js";

export interface RuntimeObservationBinding {
  generationId: string;
  baseRevision: number;
  snapshotHash: string;
}

export interface RuntimeObservation {
  binding: RuntimeObservationBinding;
  snapshot: RuntimeSnapshot;
  snapshotHash: string;
}

export interface RuntimeObserveInput {
  generationId: string;
  signal?: AbortSignal | undefined;
}

export interface RuntimeObserverDependencies {
  store: Pick<
    GenerationSessionStore,
    "read" | "writeEvidence" | "produceEvidence" | "commitSnapshot"
  >;
  adb: Pick<AdbPort, "foregroundComponent" | "pid">;
  androidCli: Pick<AndroidCliPort, "layout" | "captureScreen">;
  now: () => Date;
  createAttemptId: () => string;
}

function failedCapture(result: {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string | undefined;
}): boolean {
  return result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.spawnError !== undefined;
}

function revisionPath(revision: number): string {
  return `evidence/snapshots/revision-${String(revision).padStart(6, "0")}`;
}

function assertObservable(session: GenerationSession): void {
  if (
    session.state !== "active"
    || session.inFlight !== null
    || session.pendingConfirmation !== null
  ) {
    throw new Error("Generation session must be active and idle to observe");
  }
  if (session.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("Generation session revision cannot be incremented");
  }
}

export class RuntimeObserver {
  public constructor(
    private readonly dependencies: RuntimeObserverDependencies
  ) {}

  public readonly observe = async (
    input: RuntimeObserveInput
  ): Promise<RuntimeObservation> => {
    const current = GenerationSessionSchema.parse(
      await this.dependencies.store.read(input.generationId)
    );
    assertObservable(current);
    const identity = {
      packageName: current.target.packageName,
      deviceSerial: current.target.deviceSerial,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };
    const foreground = await this.dependencies.adb.foregroundComponent(
      identity
    );
    const pid = await this.dependencies.adb.pid(identity);
    const layout = z.array(LayoutElementSchema).parse(
      await this.dependencies.androidCli.layout({
        deviceSerial: current.target.deviceSerial,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
    );

    const baseRevision = current.revision + 1;
    const attemptId = GenerationSessionIdSchema.parse(
      this.dependencies.createAttemptId()
    );
    const evidenceDirectory = `${revisionPath(baseRevision)}/${attemptId}`;
    const screenshotPath = `${evidenceDirectory}/screen.png`;
    await this.dependencies.store.produceEvidence(
      current.id,
      screenshotPath,
      async (temporaryPath) => {
        const capture = await this.dependencies.androidCli.captureScreen({
          outputPath: temporaryPath,
          deviceSerial: current.target.deviceSerial,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        if (failedCapture(capture)) {
          throw new Error(
            capture.stderr.trim()
              || capture.spawnError
              || "Runtime screenshot capture failed"
          );
        }
      }
    );

    const snapshot = RuntimeSnapshotSchema.parse({
      version: 1,
      generationId: current.id,
      baseRevision,
      deviceSerial: current.target.deviceSerial,
      expectedPackageName: current.target.packageName,
      foregroundPackageName: foreground.packageName,
      activity: foreground.activity,
      pid,
      capturedAt: this.dependencies.now().toISOString(),
      screenshotPath,
      layout
    });
    const snapshotHash = hashRuntimeSnapshot(snapshot);
    await this.dependencies.store.writeEvidence(
      current.id,
      `${evidenceDirectory}/snapshot.json`,
      snapshot
    );
    const next = GenerationSessionSchema.parse({
      ...current,
      revision: baseRevision,
      bindings: {
        ...current.bindings,
        snapshotHash
      }
    });
    await this.dependencies.store.commitSnapshot(
      current.id,
      current.revision,
      next
    );

    return {
      binding: {
        generationId: current.id,
        baseRevision: next.revision,
        snapshotHash
      },
      snapshot,
      snapshotHash
    };
  };
}
