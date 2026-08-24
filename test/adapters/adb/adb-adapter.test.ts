import { describe, expect, it, vi } from "vitest";

import { AdbAdapter } from "../../../src/adapters/adb/adb-adapter.js";
import {
  commandResult,
  processRunner,
  runningCommand
} from "../../fakes/process-runner.js";

describe("AdbAdapter", () => {
  it("lists connected device states", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "List of devices attached",
        "emulator-5554\tdevice",
        "usb-1\tunauthorized",
        ""
      ].join("\n")
    }));

    await expect(new AdbAdapter(runner).devices()).resolves.toEqual([
      { serial: "emulator-5554", status: "device" },
      { serial: "usb-1", status: "unauthorized" }
    ]);
  });

  it("reads and normalizes the resumed Activity", async () => {
    const runner = processRunner(commandResult({
      stdout: "mResumedActivity: ActivityRecord{42 u0 com.example.app/.SearchActivity t9}"
    }));
    const adapter = new AdbAdapter(runner);

    await expect(adapter.currentActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe("com.example.app.SearchActivity");

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "dumpsys",
        "activity",
        "activities"
      ]
    });
  });

  it("returns structured foreground identity without hiding Package escape", async () => {
    const runner = processRunner(commandResult({
      stdout: "topResumedActivity=ActivityRecord{42 u0 com.android.settings/.Settings t9}"
    }));

    await expect(new AdbAdapter(runner).foregroundComponent({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toEqual({
      packageName: "com.android.settings",
      activity: "com.android.settings.Settings"
    });
  });

  it("rejects malformed resumed Activity output", async () => {
    const runner = processRunner(commandResult({
      stdout: "mResumedActivity: malformed"
    }));

    await expect(new AdbAdapter(runner).foregroundComponent({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).rejects.toThrow("ADB did not report a resumed Activity");
  });

  it("keeps currentActivity compatible by delegating to foreground identity", async () => {
    const runner = processRunner(commandResult({
      stdout: "mResumedActivity: ActivityRecord{42 u0 com.example.app/.SearchActivity t9}"
    }));
    const adapter = new AdbAdapter(runner);
    const foregroundComponent = vi.spyOn(adapter, "foregroundComponent");

    await expect(adapter.currentActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe("com.example.app.SearchActivity");

    expect(foregroundComponent).toHaveBeenCalledOnce();
  });

  it("ignores historical tasks before the resumed Activity", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "Task{123 #1 type=standard A=com.example.app/.OldActivity}",
        "  Hist #0: ActivityRecord{11 u0 com.example.app/.OldActivity t1}",
        "mResumedActivity: ActivityRecord{42 u0 com.example.app/.SearchActivity t9}"
      ].join("\n")
    }));

    await expect(new AdbAdapter(runner).currentActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe("com.example.app.SearchActivity");
  });

  it("reports a resumed Activity from another Package for mismatch diagnostics", async () => {
    const runner = processRunner(commandResult({
      stdout: "topResumedActivity=ActivityRecord{42 u0 com.android.settings/.Settings t9}"
    }));

    await expect(new AdbAdapter(runner).currentActivity({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe("com.android.settings.Settings");
  });

  it("lists App processes matching the Package, sorted by PID", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "PID NAME",
        "10 system_server",
        "1234 com.example.app",
        "1235 com.example.app:remote",
        "1230 com.other.app",
        "4321 com.example.app:other"
      ].join("\n")
    }));

    await expect(new AdbAdapter(runner).appProcesses({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toEqual([
      { pid: 1234, name: "com.example.app" },
      { pid: 1235, name: "com.example.app:remote" },
      { pid: 4321, name: "com.example.app:other" }
    ]);

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "ps",
        "-A",
        "-o",
        "PID,NAME"
      ]
    });
  });

  it("reads target-app window topology through dumpsys window", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "  Window #0 Window{abc123 u0 com.example.app/.MainActivity}:",
        "    mOwnerUid=10123 package=com.example.app appop=NONE",
        "    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION",
        "      fl=HARDWARE_ACCELERATED}",
        "    mBaseLayer=21000 mSubLayer=0",
        "    mHasSurface=true isReadyForDisplay()=true",
        "    Frames: parent=[0,0][1080,2400] frame=[0,0][1080,2400]",
        "    isOnScreen=true",
        "    isVisible=true"
      ].join("\n")
    }));

    await expect(new AdbAdapter(runner).windowTopology({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toMatchObject({
      status: "observed",
      windows: [{ id: "abc123", type: "BASE_APPLICATION" }]
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "dumpsys",
        "window",
        "windows"
      ]
    });
  });

  it("reports whether the Package is installed via pm path", async () => {
    const installedRunner = processRunner(commandResult({
      stdout: "package:/data/app/com.example.app/base.apk\n"
    }));
    await expect(new AdbAdapter(installedRunner).isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe(true);
    expect(vi.mocked(installedRunner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "pm",
        "path",
        "com.example.app"
      ]
    });

    const missingRunner = processRunner(commandResult({ stdout: "" }));
    await expect(new AdbAdapter(missingRunner).isInstalled({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe(false);
  });

  it("launches an Activity with am start -W -n", async () => {
    const runner = processRunner(commandResult({ stdout: "" }));
    const adapter = new AdbAdapter(runner);

    await adapter.launchActivity({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      deviceSerial: "emulator-5554"
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        "com.example.app/com.example.app.MainActivity"
      ]
    });
  });

  it("startActivityByIntent runs am start -W -a with the device serial", async () => {
    const runner = processRunner(commandResult({
      stdout: "Starting: Intent { act=android.intent.action.IMAGE_CAPTURE }\n"
    }));
    const adapter = new AdbAdapter(runner);

    await adapter.startActivityByIntent({
      action: "android.intent.action.IMAGE_CAPTURE",
      deviceSerial: "DEVICE1"
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "DEVICE1",
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.IMAGE_CAPTURE"
      ]
    });
  });

  it("startActivityByIntent normalizes am start Error stdout to non-zero exit", async () => {
    const runner = processRunner(commandResult({
      stdout: "Error: Activity not started\n"
    }));
    const adapter = new AdbAdapter(runner);

    const result = await adapter.startActivityByIntent({
      action: "android.intent.action.IMAGE_CAPTURE",
      deviceSerial: "DEVICE1"
    });

    expect(result.exitCode).not.toBe(0);
  });

  it("resolveLauncherActivity runs cmd package resolve-activity --brief", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true",
        "com.android.camera/.Camera"
      ].join("\n")
    }));
    const adapter = new AdbAdapter(runner);

    const result = await adapter.resolveLauncherActivity({
      packageName: "com.android.camera",
      deviceSerial: "DEVICE1"
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s", "DEVICE1",
        "shell", "cmd", "package", "resolve-activity", "--brief",
        "com.android.camera"
      ]
    });
    expect(result).toEqual({
      packageName: "com.android.camera",
      activity: ".Camera"
    });
  });

  it("resolveLauncherActivity returns undefined when no activity found", async () => {
    const runner = processRunner(commandResult({
      stdout: "No activity found\n"
    }));
    const adapter = new AdbAdapter(runner);

    const result = await adapter.resolveLauncherActivity({
      packageName: "com.nonexistent.fake",
      deviceSerial: "DEVICE1"
    });

    expect(result).toBeUndefined();
  });

  it("force-stops the exact Package on the selected device", async () => {
    const expected = commandResult({ exitCode: 1, stderr: "failure" });
    const runner = processRunner(expected);

    await expect(new AdbAdapter(runner).forceStop({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe(expected);

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "am",
        "force-stop",
        "com.example.app"
      ]
    });
  });

  it("executes tap, long click, swipe, Back, and remote-shell-safe text", async () => {
    const runner = processRunner();
    const adapter = new AdbAdapter(runner);
    const deviceSerial = "emulator-5554";

    await adapter.tap({ x: 10, y: 20 }, deviceSerial);
    await adapter.longClick({ x: 10, y: 20 }, 800, deviceSerial);
    await adapter.swipe({ x: 10, y: 20 }, { x: 10, y: 100 }, 300, deviceSerial);
    await adapter.back(deviceSerial);
    await adapter.inputText("hello world", deviceSerial);
    await adapter.inputText("a;$(id)&'中%s", deviceSerial);

    expect(vi.mocked(runner.run).mock.calls.map(([spec]) => spec.args)).toEqual([
      ["-s", deviceSerial, "shell", "input", "tap", "10", "20"],
      ["-s", deviceSerial, "shell", "input", "swipe", "10", "20", "10", "20", "800"],
      ["-s", deviceSerial, "shell", "input", "swipe", "10", "20", "10", "100", "300"],
      ["-s", deviceSerial, "shell", "input", "keyevent", "BACK"],
      ["-s", deviceSerial, "shell", "input", "text", "'hello world'"],
      ["-s", deviceSerial, "shell", "input", "text", "'a;$(id)&'\\''中%'"],
      ["-s", deviceSerial, "shell", "input", "text", "'s'"]
    ]);
  });

  it("starts Logcat as a streaming command", () => {
    const runner = processRunner();
    vi.mocked(runner.start).mockReturnValue(runningCommand());
    const adapter = new AdbAdapter(runner);
    const onStdoutLine = vi.fn();

    adapter.startLogcat({
      deviceSerial: "emulator-5554",
      onStdoutLine
    });

    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "logcat",
        "-v",
        "threadtime"
      ]
    }, { onStdoutLine });
  });
});
