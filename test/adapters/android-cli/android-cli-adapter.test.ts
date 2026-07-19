import { describe, expect, it, vi } from "vitest";

import { AndroidCliAdapter } from "../../../src/adapters/android-cli/android-cli-adapter.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

describe("AndroidCliAdapter", () => {
  it("deploys a built APK with Activity and device arguments", async () => {
    const runner = processRunner();
    const adapter = new AndroidCliAdapter(runner);

    await adapter.runApp({
      apkPath: "/project/app-debug.apk",
      activity: "com.example.app.MainActivity",
      deviceSerial: "emulator-5554"
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "android",
      args: [
        "run",
        "--apks=/project/app-debug.apk",
        "--activity=com.example.app.MainActivity",
        "--device=emulator-5554"
      ]
    });
  });

  it("reads full Layout and Layout Diff", async () => {
    const runner = processRunner(commandResult({
      stdout: JSON.stringify({
        id: "root",
        enabled: true,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        children: []
      })
    }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.layout()).resolves.toHaveLength(1);
    vi.mocked(runner.run).mockResolvedValueOnce(commandResult({ stdout: "[]" }));
    await expect(adapter.layoutDiff()).resolves.toEqual([]);

    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(1, {
      executable: "android",
      args: ["layout"]
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(2, {
      executable: "android",
      args: ["layout", "--diff"]
    });
  });

  it("captures normal and annotated screenshots", async () => {
    const runner = processRunner();
    const adapter = new AndroidCliAdapter(runner);

    await adapter.captureScreen("/tmp/final.png");
    await adapter.captureScreen("/tmp/annotated.png", true);

    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(1, {
      executable: "android",
      args: ["screen", "capture", "--output=/tmp/final.png"]
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(2, {
      executable: "android",
      args: [
        "screen",
        "capture",
        "--output=/tmp/annotated.png",
        "--annotate"
      ]
    });
  });

  it("resolves an annotated label to screen coordinates", async () => {
    const runner = processRunner(commandResult({ stdout: "(123, 456)\n" }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.resolveScreen("/tmp/annotated.png", "#7"))
      .resolves.toEqual({ x: 123, y: 456 });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "android",
      args: [
        "screen",
        "resolve",
        "--screenshot=/tmp/annotated.png",
        "--string=#7"
      ]
    });
  });
});
