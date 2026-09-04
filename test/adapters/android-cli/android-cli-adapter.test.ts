import { describe, expect, it, vi } from "vitest";

import { AndroidCliAdapter } from "../../../src/adapters/android-cli/android-cli-adapter.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

describe("AndroidCliAdapter", () => {
  it("uses the dedicated Android CLI diff backend for layout stability", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult({ stdout: "[]" }))
      .mockResolvedValueOnce(commandResult({
        stdout: JSON.stringify({ modified: [{ id: "popup" }] })
      }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.sample({
      deviceSerial: "emulator-5554"
    })).resolves.toMatchObject({
      changes: [],
      backend: "androidCli"
    });
    await expect(adapter.sample({
      deviceSerial: "emulator-5554"
    })).resolves.toMatchObject({
      changes: [{ id: "popup" }],
      backend: "androidCli"
    });
    expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(2);
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

    await expect(adapter.sample(options)).resolves.toMatchObject({
      changes: [{ frameStats: "42" }],
      backend: "gfxFrameStats"
    });
    await expect(adapter.sample(options)).resolves.toMatchObject({
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

  it("hashes Core-owned UIAutomator layouts for structural stability", async () => {
    const runner = processRunner();
    vi.mocked(runner.run).mockResolvedValue(commandResult());
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({
        stdout: "<hierarchy><node text='Home' bounds='[0,0][100,100]' " +
          "enabled='true' /></hierarchy>"
      }))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({
        stdout: "<hierarchy><node text='Home' bounds='[0,0][100,100]' " +
          "enabled='true' /></hierarchy>"
      }));
    const adapter = new AndroidCliAdapter(
      runner,
      () => "/sdcard/taphound-uiautomator.xml"
    );
    const options = {
      deviceSerial: "emulator-5554",
      packageName: "com.example.app",
      stabilityBackend: "uiautomator" as const
    };

    const first = await adapter.sample(options);
    expect(Array.isArray(first)).toBe(false);
    if (!Array.isArray(first)) {
      expect(first.backend).toBe("uiautomator");
      expect(first.layout).toHaveLength(1);
      expect(first.changes).toHaveLength(1);
      const change = first.changes[0];
      expect(change).toBeTypeOf("object");
      if (
        change !== null
        && typeof change === "object"
        && "layoutSha256" in change
      ) {
        expect(change.layoutSha256).toMatch(/^[a-f\d]{64}$/);
      }
    }
    const second = await adapter.sample(options);
    expect(Array.isArray(second)).toBe(false);
    if (!Array.isArray(second)) {
      expect(second).toMatchObject({
        changes: [],
        backend: "uiautomator"
      });
      expect(second.layout).toHaveLength(1);
    }
    expect(vi.mocked(runner.run).mock.calls.some(([spec]) => (
      spec.args.includes("gfxinfo")
    ))).toBe(false);
  });

  it("falls back to Android CLI structural diff when UIAutomator is unavailable", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult({ exitCode: 1 }))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: "[]" }));
    const adapter = new AndroidCliAdapter(runner);

    await expect(adapter.sample({
      deviceSerial: "emulator-5554",
      packageName: "com.example.app",
      stabilityBackend: "uiautomator"
    })).resolves.toMatchObject({
      changes: [],
      backend: "androidCli"
    });
    expect(vi.mocked(runner.run)).toHaveBeenNthCalledWith(3, {
      executable: "android",
      args: ["layout", "--diff", "--device=emulator-5554"]
    });
  });

  it("captures normal and annotated screenshots", async () => {
    const runner = processRunner();
    const adapter = new AndroidCliAdapter(runner);

    await adapter.capture({
      outputPath: "/tmp/final.png",
      deviceSerial: "emulator-5554"
    });
    await adapter.capture({
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

    await expect(adapter.resolve("/tmp/annotated.png", "#7"))
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
