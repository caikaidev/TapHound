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

  it("reads the Package PID", async () => {
    const runner = processRunner(commandResult({ stdout: "1234\n" }));

    await expect(new AdbAdapter(runner).pid({
      packageName: "com.example.app",
      deviceSerial: "emulator-5554"
    })).resolves.toBe(1234);
  });

  it("executes tap, long click, swipe, Back, and encoded text", async () => {
    const runner = processRunner();
    const adapter = new AdbAdapter(runner);
    const deviceSerial = "emulator-5554";

    await adapter.tap({ x: 10, y: 20 }, deviceSerial);
    await adapter.longClick({ x: 10, y: 20 }, 800, deviceSerial);
    await adapter.swipe({ x: 10, y: 20 }, { x: 10, y: 100 }, 300, deviceSerial);
    await adapter.back(deviceSerial);
    await adapter.inputText("hello world", deviceSerial);

    expect(vi.mocked(runner.run).mock.calls.map(([spec]) => spec.args)).toEqual([
      ["-s", deviceSerial, "shell", "input", "tap", "10", "20"],
      ["-s", deviceSerial, "shell", "input", "swipe", "10", "20", "10", "20", "800"],
      ["-s", deviceSerial, "shell", "input", "swipe", "10", "20", "10", "100", "300"],
      ["-s", deviceSerial, "shell", "input", "keyevent", "BACK"],
      ["-s", deviceSerial, "shell", "input", "text", "hello%sworld"]
    ]);
  });

  it("starts PID-scoped Logcat as a streaming command", () => {
    const runner = processRunner();
    vi.mocked(runner.start).mockReturnValue(runningCommand());
    const adapter = new AdbAdapter(runner);
    const onStdoutLine = vi.fn();

    adapter.startLogcat({
      deviceSerial: "emulator-5554",
      pid: 1234,
      onStdoutLine
    });

    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "logcat",
        "-v",
        "threadtime",
        "--pid=1234"
      ]
    }, { onStdoutLine });
  });
});
