import { describe, expect, it, vi } from "vitest";

import { ActionExecutor } from "../../../src/application/interaction/action-executor.js";
import {
  ExternalStepRunner,
  pollForegroundPackage
} from "../../../src/application/interaction/external-step-runner.js";
import type { IdleResult, IdleWaiter } from "../../../src/application/wait/idle-waiter.js";
import type { ExternalStep } from "../../../src/domain/external-flow.js";
import type { LayoutElement } from "../../../src/domain/layout.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import { FakeClock } from "../../fakes/fake-clock.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

const CAMERA = "com.android.camera";
const CAMERA_ACTIVITY = "com.android.camera.CameraActivity";

const shutter: LayoutElement = {
  id: "shutter",
  resourceId: "shutter_button",
  enabled: true,
  clickable: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  children: []
};
const banner: LayoutElement = {
  id: "banner",
  resourceId: "video_banner",
  enabled: true,
  bounds: { left: 0, top: 200, right: 100, bottom: 260 },
  children: []
};

const stable: IdleResult = {
  status: "stable",
  polls: 2,
  durationMs: 1,
  strategy: "structural",
  fallbackUsed: false,
  frameActivityDetected: false,
  samplingDurationMs: 1
};

function harness(options: {
  layout?: readonly LayoutElement[];
  foreground?: { packageName: string; activity: string };
  idle?: IdleResult;
} = {}): {
  runner: ExternalStepRunner;
  tap: ReturnType<typeof vi.fn>;
  onIdleTimeout: ReturnType<typeof vi.fn>;
} {
  const tap = vi.fn(() => Promise.resolve({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false
  }));
  const adb = {
    foregroundComponent: vi.fn(() => Promise.resolve(
      options.foreground ?? { packageName: CAMERA, activity: CAMERA_ACTIVITY }
    )),
    tap
  } as unknown as AdbPort;
  const onIdleTimeout = vi.fn(() => Promise.resolve());
  const runner = new ExternalStepRunner({
    adb,
    actionExecutor: new ActionExecutor(adb, "serial", () => undefined),
    uiSnapshotProvider: uiSnapshotProvider(),
    captureLayout: (): Promise<readonly LayoutElement[]> => (
      Promise.resolve(options.layout ?? [shutter])
    ),
    createIdleWaiter: (): IdleWaiter => ({
      waitUntilIdle: vi.fn(() => Promise.resolve(options.idle ?? stable))
    }) as unknown as IdleWaiter,
    idle: { pollIntervalMs: 1, stablePolls: 1, timeoutMs: 10 },
    viewport: (): undefined => undefined,
    deviceSerial: "serial",
    onIdleTimeout
  });
  return { runner, tap, onIdleTimeout };
}

function click(expect?: ExternalStep["expect"]): ExternalStep {
  return {
    action: "click",
    locator: { resourceId: "shutter_button" },
    expectedActivity: CAMERA_ACTIVITY,
    ...(expect === undefined ? {} : { expect })
  };
}

const bannerAbsent: ExternalStep["expect"] = {
  type: "element",
  locator: { resourceId: "video_banner" },
  absent: true,
  timeoutMs: 100
};

describe("ExternalStepRunner", () => {
  it("passes an absent element expectation when the element is gone", async () => {
    const { runner, tap } = harness({ layout: [shutter] });

    await expect(runner.run([click(bannerAbsent)], CAMERA))
      .resolves.toEqual({ status: "passed" });
    expect(tap).toHaveBeenCalledOnce();
  });

  it("fails an absent element expectation when the element is still shown", async () => {
    const { runner } = harness({ layout: [shutter, banner] });

    await expect(runner.run([click(bannerAbsent)], CAMERA)).resolves.toMatchObject({
      status: "failed",
      stepIndex: 0,
      code: "EXTERNAL_STEP_FAILED"
    });
  });

  it("refuses to act when another package took the foreground", async () => {
    const { runner, tap } = harness({
      foreground: { packageName: "com.other", activity: "com.other.Main" }
    });

    await expect(runner.run([click()], CAMERA)).resolves.toMatchObject({
      status: "failed",
      code: "EXTERNAL_PACKAGE_MISMATCH"
    });
    expect(tap).not.toHaveBeenCalled();
  });

  it("records idle-timeout evidence before failing the step", async () => {
    const { runner, onIdleTimeout } = harness({
      idle: {
        status: "timeout",
        code: "IDLE_TIMEOUT",
        polls: 3,
        durationMs: 10,
        lastDiff: [{ changed: true }],
        strategy: "structural",
        fallbackUsed: false,
        frameActivityDetected: false,
        samplingDurationMs: 10
      }
    });

    await expect(runner.run([click()], CAMERA)).resolves.toMatchObject({
      status: "failed",
      code: "IDLE_TIMEOUT"
    });
    expect(onIdleTimeout).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ lastDiff: [{ changed: true }] })
    );
  });

  it("reports cancellation instead of a failure", async () => {
    const { runner, tap } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run([click()], CAMERA, controller.signal))
      .resolves.toEqual({ status: "cancelled" });
    expect(tap).not.toHaveBeenCalled();
  });
});

describe("pollForegroundPackage", () => {
  it("times out on the injected clock without wall-clock waits", async () => {
    const clock = new FakeClock();
    const adb = {
      foregroundComponent: vi.fn(() => Promise.resolve({
        packageName: "dev.app",
        activity: "dev.app.Main"
      }))
    };

    await expect(pollForegroundPackage({
      adb,
      clock,
      packageName: "dev.app",
      deviceSerial: "serial",
      until: (packageName) => packageName !== "dev.app",
      timeoutMs: 1200
    })).resolves.toEqual({ status: "timeout" });
    expect(clock.sleeps).toEqual([500, 500, 200]);
  });
});
