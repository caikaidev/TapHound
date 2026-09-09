import { describe, expect, it, vi } from "vitest";

import {
  FakeRuntimeBackend,
  FakeRuntimeSession
} from "../../../src/adapters/runtime/fake-runtime-backend.js";
import {
  SharedSessionRuntimeBackend
} from "../../../src/adapters/runtime/shared-session-runtime-backend.js";
import {
  FailClosedAnnotatedScreenResolver,
  SessionBackedScreenshotAdapter,
  SessionBackedUiSnapshotProviderFactory,
  SessionBackedUiStabilityAdapter
} from "../../../src/adapters/runtime/session-backed-ports.js";
import type { RuntimeSession } from "../../../src/ports/runtime-backend.js";
import type {
  OpenRuntimeUiSnapshotsOptions
} from "../../../src/ports/runtime-backend.js";
import type { AnnotatedScreenResolverPort } from "../../../src/ports/annotated-screen-resolver.js";
import type { UiSnapshotProvider } from "../../../src/ports/ui-snapshot.js";

class RecordingSession extends FakeRuntimeSession {
  public readonly openedUiSnapshotOptions: (
    | OpenRuntimeUiSnapshotsOptions
    | undefined
  )[] = [];

  public override openUiSnapshots(
    options?: OpenRuntimeUiSnapshotsOptions
  ): Promise<UiSnapshotProvider> {
    this.openedUiSnapshotOptions.push(options);
    return super.openUiSnapshots();
  }
}

function backendWithRecordingSessions(): {
  backend: FakeRuntimeBackend;
  sessions: RecordingSession[];
  resets: ReturnType<typeof vi.fn>;
  samples: ReturnType<typeof vi.fn>;
} {
  const sessions: RecordingSession[] = [];
  const resets = vi.fn();
  const samples = vi.fn((): Promise<readonly unknown[]> => (
    Promise.resolve([])
  ));
  const backend = new FakeRuntimeBackend({
    sessions: (options): RuntimeSession => {
      const session = new RecordingSession({
        descriptor: {
          id: "adb",
          adapterVersion: "recording",
          configSha256: "0".repeat(64),
          capabilities: new FakeRuntimeBackend().capabilities
        },
        deviceSerial: options.deviceSerial,
        uiStability: {
          reset: resets,
          sample: samples
        }
      });
      sessions.push(session);
      return session;
    }
  });
  return { backend, sessions, resets, samples };
}

describe("SessionBackedScreenshotAdapter", () => {
  it("routes captures through the session bound to the device serial", async () => {
    const { backend, sessions } = backendWithRecordingSessions();
    const adapter = new SessionBackedScreenshotAdapter(backend);

    const result = await adapter.capture({
      deviceSerial: "emulator-5554",
      outputPath: "/tmp/report/final.png"
    });

    expect(result.exitCode).toBe(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.calls).toContain("captureScreenshot:/tmp/report/final.png");
  });

  it("reuses the memoized session for the same serial", async () => {
    const { backend, sessions } = backendWithRecordingSessions();
    const adapter = new SessionBackedScreenshotAdapter(
      new SharedSessionRuntimeBackend(backend)
    );

    await adapter.capture({ deviceSerial: "emulator-5554", outputPath: "/a.png" });
    await adapter.capture({ deviceSerial: "emulator-5554", outputPath: "/b.png" });

    expect(sessions).toHaveLength(1);
  });
});

describe("SessionBackedUiStabilityAdapter", () => {
  it("samples through the session for the requested serial", async () => {
    const { backend, samples } = backendWithRecordingSessions();
    const adapter = new SessionBackedUiStabilityAdapter(backend);

    await adapter.sample({ deviceSerial: "emulator-5554" });

    expect(samples).toHaveBeenCalledWith({ deviceSerial: "emulator-5554" });
  });

  it("resets every session that has been sampled", async () => {
    const { backend, resets } = backendWithRecordingSessions();
    const adapter = new SessionBackedUiStabilityAdapter(backend);

    adapter.reset();
    expect(resets).not.toHaveBeenCalled();

    await adapter.sample({ deviceSerial: "emulator-5554" });
    await adapter.sample({ deviceSerial: "emulator-5556" });
    adapter.reset();

    expect(resets).toHaveBeenCalledTimes(2);
  });
});

describe("SessionBackedUiSnapshotProviderFactory", () => {
  it("opens the session snapshot provider with forwarded options", async () => {
    const { backend, sessions } = backendWithRecordingSessions();
    const factory = new SessionBackedUiSnapshotProviderFactory(backend);
    const signal = new AbortController().signal;

    const provider = await factory.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 2500,
      backend: "auto",
      signal
    });

    expect(provider.descriptor).toBeDefined();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.openedUiSnapshotOptions).toEqual([
      { timeoutMs: 2500, backend: "auto", signal }
    ]);
  });

  it("reuses the memoized session across repeated opens", async () => {
    const { backend, sessions } = backendWithRecordingSessions();
    const factory = new SessionBackedUiSnapshotProviderFactory(
      new SharedSessionRuntimeBackend(backend)
    );

    await factory.open({ deviceSerial: "emulator-5554", timeoutMs: 1000 });
    await factory.open({ deviceSerial: "emulator-5554", timeoutMs: 1000 });

    expect(sessions).toHaveLength(1);
  });
});

describe("FailClosedAnnotatedScreenResolver", () => {
  it("rejects annotated screen resolution with a coded capability error", async () => {
    const resolver: AnnotatedScreenResolverPort =
      new FailClosedAnnotatedScreenResolver("mobile-mcp");

    const error = await resolver.resolve("/tmp/screen.png", "Continue").then(
      () => undefined,
      (rethrown: unknown): unknown => rethrown
    );
    expect(error).toMatchObject({
      code: "RUNTIME_CAPABILITY_MISSING"
    });
    expect((error as Error).message)
      .toContain('does not support annotated screens');
    expect((error as Error).message).toContain("TAPHOUND_RUNTIME_BACKEND");
  });
});
