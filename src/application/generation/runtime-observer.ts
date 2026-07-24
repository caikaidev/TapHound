import { z } from "zod";

import {
  GenerationSessionIdSchema,
  GenerationSessionSchema,
  type GenerationSession,
  type PendingConfirmation
} from "../../domain/generation.js";
import { LayoutElementSchema } from "../../domain/layout.js";
import {
  ProposalBindingSchema,
  type ProposalBinding
} from "../../domain/proposed-step.js";
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
import { GenerationOperationError } from "./generation-starter.js";

export type RuntimeObservationBinding = ProposalBinding;

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

export interface SnapshotReobservationGuardDependencies {
  store: Pick<GenerationSessionStore, "read">;
  adb: Pick<AdbPort, "foregroundComponent" | "pid">;
  androidCli: Pick<AndroidCliPort, "layout">;
  now: () => Date;
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

async function collectRuntime(
  dependencies: {
    adb: Pick<AdbPort, "foregroundComponent" | "pid">;
    androidCli: Pick<AndroidCliPort, "layout">;
  },
  session: GenerationSession,
  signal?: AbortSignal
): Promise<{
  foregroundPackageName: string;
  activity: string;
  pid: number | null;
  layout: z.infer<typeof LayoutElementSchema>[];
}> {
  const identity = {
    packageName: session.target.packageName,
    deviceSerial: session.target.deviceSerial,
    ...(signal === undefined ? {} : { signal })
  };
  const foreground = await dependencies.adb.foregroundComponent(identity);
  const pid = await dependencies.adb.pid(identity);
  const layout = z.array(LayoutElementSchema).parse(
    await dependencies.androidCli.layout({
      deviceSerial: session.target.deviceSerial,
      ...(signal === undefined ? {} : { signal })
    })
  );
  return {
    foregroundPackageName: foreground.packageName,
    activity: foreground.activity,
    pid,
    layout
  };
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
    const runtime = await collectRuntime(
      this.dependencies,
      current,
      input.signal
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
      foregroundPackageName: runtime.foregroundPackageName,
      activity: runtime.activity,
      pid: runtime.pid,
      capturedAt: this.dependencies.now().toISOString(),
      screenshotPath,
      layout: runtime.layout
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

export class SnapshotReobservationGuard {
  public constructor(
    private readonly dependencies: SnapshotReobservationGuardDependencies
  ) {}

  public readonly assertFresh = async (
    input: ProposalBinding,
    signal?: AbortSignal,
    approvedConfirmation?: PendingConfirmation
  ): Promise<RuntimeSnapshot> => {
    try {
      const binding = ProposalBindingSchema.parse(input);
      const session = GenerationSessionSchema.parse(
        await this.dependencies.store.read(binding.generationId)
      );
      if (
        session.id !== binding.generationId
        || session.state !== "active"
        || session.bindings.snapshotHash !== binding.snapshotHash
        || session.inFlight !== null
        || session.verification.status !== "notRun"
        || session.publication.status !== "notRun"
        || (
          approvedConfirmation === undefined
            ? (
                session.revision !== binding.baseRevision
                || session.pendingConfirmation !== null
              )
            : (
                approvedConfirmation.status !== "approved"
                || session.revision !== binding.baseRevision + 2
                || JSON.stringify(session.pendingConfirmation)
                  !== JSON.stringify(approvedConfirmation)
              )
        )
      ) {
        throw new GenerationOperationError(
          "SNAPSHOT_STALE",
          "Proposal snapshot binding is no longer authoritative"
        );
      }
      const runtime = await collectRuntime(
        this.dependencies,
        session,
        signal
      );
      const snapshot = RuntimeSnapshotSchema.parse({
        version: 1,
        generationId: session.id,
        baseRevision: binding.baseRevision,
        deviceSerial: session.target.deviceSerial,
        expectedPackageName: session.target.packageName,
        foregroundPackageName: runtime.foregroundPackageName,
        activity: runtime.activity,
        pid: runtime.pid,
        capturedAt: this.dependencies.now().toISOString(),
        screenshotPath: "non-authoritative://runtime-reobservation",
        layout: runtime.layout
      });
      if (hashRuntimeSnapshot(snapshot) !== binding.snapshotHash) {
        throw new GenerationOperationError(
          "SNAPSHOT_STALE",
          "Runtime snapshot changed after proposal"
        );
      }
      return snapshot;
    } catch (error) {
      if (
        error instanceof GenerationOperationError
        && error.code === "SNAPSHOT_STALE"
      ) {
        throw error;
      }
      throw new GenerationOperationError(
        "SNAPSHOT_STALE",
        "Runtime snapshot could not be re-observed"
      );
    }
  };
}
