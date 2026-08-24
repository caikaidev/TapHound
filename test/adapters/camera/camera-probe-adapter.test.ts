import { describe, expect, it } from "vitest";

import { CameraProbeAdapter } from "../../../src/adapters/camera/camera-probe-adapter.js";
import type {
  AdbPort,
  AppIdentity,
  DeviceInfo
} from "../../../src/ports/adb.js";
import type {
  AndroidCliPort,
  LayoutDiffResult,
  Point
} from "../../../src/ports/android-cli.js";
import type {
  CommandResult,
  RunningCommand
} from "../../../src/ports/process-runner.js";
import { commandResult, runningCommand } from "../../fakes/process-runner.js";
import type { ForegroundComponent } from "../../../src/domain/activity.js";
import type { LayoutElement } from "../../../src/domain/layout.js";

interface FakeAdb {
  foregroundSequence: ForegroundComponent[];
  startActivityResult: CommandResult;
  tapCalls: Point[];
  forceStopCalls: string[];
}

function makeAdb(fake: FakeAdb): AdbPort {
  let fgIndex = 0;
  const readForeground = (): ForegroundComponent => {
    const fallback = fake.foregroundSequence[fake.foregroundSequence.length - 1];
    if (fallback === undefined) {
      throw new Error("FakeAdb foregroundSequence is empty");
    }
    const current = fake.foregroundSequence[fgIndex] ?? fallback;
    fgIndex = Math.min(fgIndex + 1, fake.foregroundSequence.length - 1);
    return current;
  };
  return {
    devices: (): Promise<readonly DeviceInfo[]> => Promise.resolve([
      { serial: "DEVICE1", status: "device" }
    ]),
    foregroundComponent: (): Promise<ForegroundComponent> => Promise.resolve(readForeground()),
    currentActivity: (): Promise<string> => Promise.resolve(readForeground().activity),
    isInstalled: (): Promise<boolean> => Promise.resolve(true),
    launchActivity: (): Promise<CommandResult> => Promise.resolve(fake.startActivityResult),
    startActivityByIntent: (): Promise<CommandResult> => Promise.resolve(fake.startActivityResult),
    forceStop: (identity: AppIdentity): Promise<CommandResult> => {
      fake.forceStopCalls.push(identity.packageName);
      return Promise.resolve(commandResult());
    },
    appProcesses: (): Promise<readonly never[]> => Promise.resolve([]),
    windowTopology: () => Promise.resolve({
      version: 1 as const,
      status: "observed" as const,
      windows: []
    }),
    tap: (point: Point): Promise<CommandResult> => {
      fake.tapCalls.push(point);
      return Promise.resolve(commandResult());
    },
    longClick: (): Promise<CommandResult> => Promise.resolve(commandResult()),
    swipe: (): Promise<CommandResult> => Promise.resolve(commandResult()),
    back: (): Promise<CommandResult> => Promise.resolve(commandResult()),
    inputText: (): Promise<CommandResult> => Promise.resolve(commandResult()),
    startLogcat: (): RunningCommand => runningCommand()
  };
}

function makeAndroidCli(layouts: LayoutElement[][]): AndroidCliPort {
  let layoutIndex = 0;
  return {
    layout: (): Promise<readonly LayoutElement[]> => {
      const fallback = layouts[layouts.length - 1];
      if (fallback === undefined) {
        throw new Error("makeAndroidCli layouts is empty");
      }
      const current = layouts[layoutIndex] ?? fallback;
      layoutIndex = Math.min(layoutIndex + 1, layouts.length - 1);
      return Promise.resolve(current);
    },
    layoutDiff: (): Promise<LayoutDiffResult> => Promise.resolve([]),
    captureScreen: (): Promise<CommandResult> => Promise.resolve(commandResult()),
    resolveScreen: (): Promise<Point> => Promise.resolve({ x: 0, y: 0 })
  };
}

function element(opts: {
  resourceId?: string;
  contentDescription?: string;
  clickable?: boolean;
  enabled?: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
}): LayoutElement {
  return {
    id: opts.resourceId ?? "node",
    ...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
    ...(opts.contentDescription !== undefined
      ? { contentDescription: opts.contentDescription }
      : {}),
    clickable: opts.clickable ?? true,
    enabled: opts.enabled ?? true,
    bounds: opts.bounds ?? { left: 0, top: 0, right: 100, bottom: 100 },
    center: { x: 50, y: 50 },
    children: []
  };
}

function makeFakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let currentTime = 0;
  return {
    now: (): number => currentTime,
    sleep: (ms: number): Promise<void> => {
      currentTime += ms;
      return Promise.resolve();
    }
  };
}

const hostForeground: ForegroundComponent = {
  packageName: "com.example.app",
  activity: "com.example.app.MainActivity"
};
const cameraForeground: ForegroundComponent = {
  packageName: "com.android.camera",
  activity: "com.android.camera.CameraActivity"
};

const shutterLayout: LayoutElement[] = [
  element({ resourceId: "com.android.camera:id/shutter_button", contentDescription: "快门按钮" })
];

describe("CameraProbeAdapter", () => {
  it("discovers shutter and confirm for a 3-step camera", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const confirmLayout: LayoutElement[] = [
      element({ resourceId: "com.android.camera:id/shutter_button", contentDescription: "快门按钮" }),
      element({ resourceId: "com.android.camera:id/btn_done", contentDescription: "完成" })
    ];
    const androidCli = makeAndroidCli([shutterLayout, confirmLayout, confirmLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    const result = await probe.probe({ deviceSerial: "DEVICE1" });

    expect(result.packageName).toBe("com.android.camera");
    expect(result.activityName).toBe("com.android.camera.CameraActivity");
    expect(result.shutterResourceId).toBe("com.android.camera:id/shutter_button");
    expect(result.confirmResourceId).toBe("com.android.camera:id/btn_done");
    expect(fake.tapCalls).toHaveLength(1);
    expect(fake.forceStopCalls).toEqual(["com.android.camera"]);
  });

  it("discovers shutter only for a 2-step auto-accept camera", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const androidCli = makeAndroidCli([shutterLayout, shutterLayout, shutterLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    const result = await probe.probe({ deviceSerial: "DEVICE1" });

    expect(result.shutterResourceId).toBe("com.android.camera:id/shutter_button");
    expect(result.confirmResourceId).toBeUndefined();
  });

  it("throws ALIGN_CAMERA_NOT_LAUNCHED when foreground never changes", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        hostForeground,
        hostForeground,
        hostForeground,
        hostForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const androidCli = makeAndroidCli([shutterLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_CAMERA_NOT_LAUNCHED/);
  });

  it("throws ALIGN_CAMERA_INTENT_FAILED when am start returns non-zero", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [hostForeground],
      startActivityResult: commandResult({
        stdout: "Error: Activity not started\n",
        exitCode: 1
      }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const androidCli = makeAndroidCli([shutterLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_CAMERA_INTENT_FAILED/);
  });

  it("throws ALIGN_SHUTTER_NOT_FOUND when no element matches", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const emptyLayout: LayoutElement[] = [
      element({ resourceId: "com.android.camera:id/other", contentDescription: "something" })
    ];
    const androidCli = makeAndroidCli([emptyLayout, emptyLayout, emptyLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_SHUTTER_NOT_FOUND/);
    expect(fake.forceStopCalls).toEqual(["com.android.camera"]);
  });

  it("throws ALIGN_SHUTTER_NO_RESOURCE_ID when shutter has no resourceId", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const noIdLayout: LayoutElement[] = [element({ contentDescription: "快门" })];
    const androidCli = makeAndroidCli([noIdLayout, noIdLayout, noIdLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_SHUTTER_NO_RESOURCE_ID/);
  });

  it("throws ALIGN_SHUTTER_AMBIGUOUS when multiple matches and no resourceId contains shutter", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const ambiguousLayout: LayoutElement[] = [
      element({ resourceId: "com.android.camera:id/button_a", contentDescription: "拍照" }),
      element({ resourceId: "com.android.camera:id/button_b", contentDescription: "capture" })
    ];
    const androidCli = makeAndroidCli([ambiguousLayout, ambiguousLayout, ambiguousLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_SHUTTER_AMBIGUOUS/);
  });

  it("throws ALIGN_CONFIRM_AMBIGUOUS when multiple confirm candidates and no resourceId matches", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const confirmAmbiguousLayout: LayoutElement[] = [
      element({ resourceId: "com.android.camera:id/shutter_button", contentDescription: "快门按钮" }),
      element({ resourceId: "com.android.camera:id/x1", contentDescription: "完成" }),
      element({ resourceId: "com.android.camera:id/x2", contentDescription: "确定" })
    ];
    const androidCli = makeAndroidCli([shutterLayout, confirmAmbiguousLayout, confirmAmbiguousLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(/ALIGN_CONFIRM_AMBIGUOUS/);
  });

  it("forceStops the camera even on failure (cleanup invariant)", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const emptyLayout: LayoutElement[] = [
      element({ resourceId: "com.android.camera:id/other", contentDescription: "something" })
    ];
    const androidCli = makeAndroidCli([emptyLayout, emptyLayout, emptyLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow();
    expect(fake.forceStopCalls).toEqual(["com.android.camera"]);
  });

  it("forceStops an existing camera app before launching the intent", async () => {
    const fake: FakeAdb = {
      foregroundSequence: [
        cameraForeground,
        hostForeground,
        cameraForeground,
        cameraForeground,
        cameraForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const androidCli = makeAndroidCli([shutterLayout, shutterLayout, shutterLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await probe.probe({ deviceSerial: "DEVICE1" });
    expect(fake.forceStopCalls[0]).toBe("com.android.camera");
  });

  it("throws ALIGN_CAMERA_INTENT_FAILED when IMAGE_CAPTURE lands on a resolver/chooser", async () => {
    const resolverForeground: ForegroundComponent = {
      packageName: "com.android.internal.app.ResolverActivity",
      activity: "com.android.internal.app.ResolverActivity"
    };
    const fake: FakeAdb = {
      foregroundSequence: [
        hostForeground,
        resolverForeground,
        resolverForeground
      ],
      startActivityResult: commandResult({ stdout: "Starting: Intent\n" }),
      tapCalls: [],
      forceStopCalls: []
    };
    const adb = makeAdb(fake);
    const androidCli = makeAndroidCli([shutterLayout]);
    const clock = makeFakeClock();

    const probe = new CameraProbeAdapter({ adb, androidCli, now: clock.now, sleep: clock.sleep });
    await expect(probe.probe({ deviceSerial: "DEVICE1" })).rejects.toThrow(
      /ALIGN_CAMERA_INTENT_FAILED: IMAGE_CAPTURE landed on system resolver\/chooser/
    );
  });
});
