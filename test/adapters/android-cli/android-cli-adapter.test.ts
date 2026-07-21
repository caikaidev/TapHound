import { describe, expect, it, vi } from "vitest";

import { AndroidCliAdapter } from "../../../src/adapters/android-cli/android-cli-adapter.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

describe("AndroidCliAdapter", () => {
  it("reads an APK from current Android CLI describe output", async () => {
    const runner = processRunner(commandResult({
      stdout: [
        "Task: :core-sdk",
        "  Variants:",
        "    Variant: debug",
        "      Output Listing File: null",
        "Task: :app",
        "  Variants:",
        "    Variant: debug",
        "      Output Listing File: /project/redirect.txt",
        "        APK: /project/app/build/outputs/apk/debug/app-debug.apk (Exists)",
        "    Variant: release",
        "      Output Listing File: null",
        "gradlew completed successfully."
      ].join("\n")
    }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.describeProject({
      projectDir: "/project",
      target: "app",
      variant: "debug"
    })).resolves.toEqual({
      apkPath: "/project/app/build/outputs/apk/debug/app-debug.apk",
      metadataPaths: []
    });
  });

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

    await expect(adapter.layout({ deviceSerial: "emulator-5554" }))
      .resolves.toHaveLength(1);
    vi.mocked(runner.run).mockResolvedValueOnce(commandResult({ stdout: "[]" }));
    await expect(adapter.layoutDiff({ deviceSerial: "emulator-5554" }))
      .resolves.toEqual([]);

    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(1, {
      executable: "android",
      args: ["layout", "--device=emulator-5554"]
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(2, {
      executable: "android",
      args: ["layout", "--diff", "--device=emulator-5554"]
    });
  });

  it("captures normal and annotated screenshots", async () => {
    const runner = processRunner();
    const adapter = new AndroidCliAdapter(runner);

    await adapter.captureScreen({
      outputPath: "/tmp/final.png",
      deviceSerial: "emulator-5554"
    });
    await adapter.captureScreen({
      outputPath: "/tmp/annotated.png",
      annotate: true,
      deviceSerial: "emulator-5554"
    });

    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(1, {
      executable: "android",
      args: [
        "screen",
        "capture",
        "--output=/tmp/final.png",
        "--device=emulator-5554"
      ]
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(2, {
      executable: "android",
      args: [
        "screen",
        "capture",
        "--output=/tmp/annotated.png",
        "--annotate",
        "--device=emulator-5554"
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
