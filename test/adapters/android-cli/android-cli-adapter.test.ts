import { describe, expect, it, vi } from "vitest";

import { AndroidCliAdapter } from "../../../src/adapters/android-cli/android-cli-adapter.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

describe("AndroidCliAdapter", () => {
  it("reads full Layout and Layout Diff", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult({ exitCode: 1 }))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({
        stdout: JSON.stringify({
          id: "root",
          enabled: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          children: []
        })
      }));
    const adapter = new AndroidCliAdapter(
      runner,
      () => "/sdcard/taphound-uiautomator.xml"
    );

    await expect(adapter.layout({ deviceSerial: "emulator-5554" }))
      .resolves.toHaveLength(1);
    vi.mocked(runner.run).mockResolvedValueOnce(commandResult({ stdout: "[]" }));
    await expect(adapter.layoutDiff({ deviceSerial: "emulator-5554" }))
      .resolves.toMatchObject({
        changes: [],
        backend: "androidCli"
      });

    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(1, {
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/taphound-uiautomator.xml"
      ]
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(4, {
      executable: "android",
      args: ["layout", "--diff", "--device=emulator-5554"]
    });
  });

  it("uses the dedicated Android CLI diff backend for layout stability", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({
        stdout: "<hierarchy><node text='Home' bounds='[0,0][100,100]' " +
          "enabled='true' /></hierarchy>"
      }))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: "[]" }))
      .mockResolvedValueOnce(commandResult({
        stdout: JSON.stringify({ modified: [{ id: "popup" }] })
      }));
    const adapter = new AndroidCliAdapter(runner);

    await adapter.layout({ deviceSerial: "emulator-5554" });
    await expect(adapter.layoutDiff({
      deviceSerial: "emulator-5554"
    })).resolves.toMatchObject({
      changes: [],
      backend: "androidCli"
    });
    await expect(adapter.layoutDiff({
      deviceSerial: "emulator-5554"
    })).resolves.toMatchObject({
      changes: [{ id: "popup" }],
      backend: "androidCli"
    });
    expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(5);
  });

  it("uses fast frame counters when the target package is known", async () => {
    const runner = processRunner(commandResult({
      stdout: "Total frames rendered: 42\n"
    }));
    const adapter = new AndroidCliAdapter(runner);
    const options = {
      deviceSerial: "emulator-5554",
      packageName: "com.example.app"
    };

    await expect(adapter.layoutDiff(options)).resolves.toMatchObject({
      changes: [{ frameStats: "42" }],
      backend: "gfxFrameStats"
    });
    await expect(adapter.layoutDiff(options)).resolves.toMatchObject({
      changes: [],
      backend: "gfxFrameStats"
    });
    expect(runner.run).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "dumpsys",
        "gfxinfo",
        "com.example.app"
      ]
    });
  });

  it("does not fall back after a UIAutomator timeout", async () => {
    const runner = processRunner(commandResult({
      exitCode: null,
      timedOut: true
    }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.layout({
      deviceSerial: "emulator-5554",
      timeoutMs: 100
    })).rejects.toThrow(/deadline/);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: "android" })
    );
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
