import { describe, expect, it, vi } from "vitest";

import {
  AndroidCliSnapshotProviderFactory
} from "../../../src/adapters/android-cli/android-cli-snapshot-provider.js";
import {
  AutoUiSnapshotProviderFactory
} from "../../../src/adapters/ui/auto-ui-snapshot-provider.js";
import {
  UiSnapshotError
} from "../../../src/adapters/ui/ui-snapshot-error.js";
import {
  parseDisplayRotation
} from "../../../src/adapters/ui/device-ui-environment.js";
import {
  SystemUiAutomatorSnapshotProviderFactory
} from "../../../src/adapters/adb/system-uiautomator-snapshot-provider.js";
import type {
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../../src/ports/ui-snapshot.js";
import type { CommandResult } from "../../../src/ports/process-runner.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";
import { uiSnapshotProvider } from "../../fakes/ui-snapshot.js";

function environmentResults(): [CommandResult, CommandResult, CommandResult] {
  return [
    commandResult({ stdout: "36\n" }),
    commandResult({ stdout: "Physical size: 1080x1920\n" }),
    commandResult({ stdout: "SurfaceOrientation: 0\n" })
  ];
}

const systemXml = '<hierarchy><node resource-id="com.example:id/root" ' +
  'bounds="[0,0][1080,1920]" enabled="true" /></hierarchy>';

describe("bound UI snapshot providers", () => {
  it("reads Android 16 viewport rotation when SurfaceOrientation is absent", () => {
    expect(parseDisplayRotation(
      "Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1200, 2670]"
    )).toBe(0);
    expect(parseDisplayRotation(
      "Viewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 2670, 1200]"
    )).toBe(90);
  });
  it("binds System UIAutomator once and attributes physical-display snapshots", async () => {
    const runner = processRunner();
    vi.mocked(runner.run).mockResolvedValue(commandResult());
    vi.mocked(runner.run)
      .mockResolvedValueOnce(environmentResults()[0])
      .mockResolvedValueOnce(environmentResults()[1])
      .mockResolvedValueOnce(environmentResults()[2])
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: systemXml }))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult({ stdout: systemXml }))
      .mockResolvedValueOnce(commandResult());
    const factory = new SystemUiAutomatorSnapshotProviderFactory(
      runner,
      { createLayoutPath: (): string => "/data/local/tmp/taphound.xml" }
    );

    const provider = await factory.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });
    const snapshot = await provider.capture({
      reason: "locate",
      timeoutMs: 1000
    });

    expect(provider.descriptor.id).toBe("system-uiautomator");
    expect(snapshot).toMatchObject({
      backend: provider.descriptor,
      viewport: {
        width: 1080,
        height: 1920,
        rotation: 0,
        coordinateSpace: "physicalDisplayPixels"
      },
      roots: [{ resourceId: "root" }]
    });
    expect(vi.mocked(runner.run).mock.calls.filter(([spec]) => (
      spec.executable === "android"
    ))).toHaveLength(0);
  });

  it("binds Android CLI without invoking System UIAutomator capture", async () => {
    const runner = processRunner();
    const source = JSON.stringify({
      id: "root",
      resourceId: "com.example:id/root",
      enabled: true,
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      children: []
    });
    vi.mocked(runner.run)
      .mockResolvedValueOnce(environmentResults()[0])
      .mockResolvedValueOnce(environmentResults()[1])
      .mockResolvedValueOnce(environmentResults()[2])
      .mockResolvedValueOnce(commandResult({ stdout: source }))
      .mockResolvedValueOnce(commandResult({ stdout: source }));
    const provider = await new AndroidCliSnapshotProviderFactory(runner).open({
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });

    const snapshot = await provider.capture({
      reason: "observe",
      timeoutMs: 1000
    });

    expect(provider.descriptor.id).toBe("android-cli");
    expect(snapshot.roots[0]).toMatchObject({ resourceId: "root" });
    expect(vi.mocked(runner.run).mock.calls.filter(([spec]) => (
      spec.args.includes("uiautomator")
    ))).toHaveLength(0);
  });

  it("rejects API levels below 26 with a typed availability error", async () => {
    const runner = processRunner(commandResult({ stdout: "25\n" }));

    await expect(new SystemUiAutomatorSnapshotProviderFactory(runner).open({
      deviceSerial: "legacy-device",
      timeoutMs: 1000
    })).rejects.toMatchObject({
      code: "UI_BACKEND_UNAVAILABLE",
      backendId: "system-uiautomator"
    });
  });

  it("falls back only while auto is opening and never after binding", async () => {
    const systemOpen = vi.fn<UiSnapshotProviderFactory["open"]>(() => (
      Promise.reject(new UiSnapshotError(
        "UI_BACKEND_UNAVAILABLE",
        "system-uiautomator",
        "not available"
      ))
    ));
    const bound = uiSnapshotProvider();
    vi.mocked(bound.capture).mockRejectedValue(new UiSnapshotError(
      "UI_SNAPSHOT_FAILED",
      "android-cli",
      "capture failed"
    ));
    const androidOpen = vi.fn<UiSnapshotProviderFactory["open"]>(() => (
      Promise.resolve(bound)
    ));
    const auto = new AutoUiSnapshotProviderFactory(
      { open: systemOpen },
      { open: androidOpen }
    );

    const provider: UiSnapshotProvider = await auto.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 1000
    });
    await expect(provider.capture({
      reason: "evidence",
      timeoutMs: 1000
    })).rejects.toMatchObject({ code: "UI_SNAPSHOT_FAILED" });

    expect(systemOpen).toHaveBeenCalledOnce();
    expect(androidOpen).toHaveBeenCalledOnce();
  });

  it("honors an explicit backend without probing another implementation", async () => {
    const system = uiSnapshotProvider();
    const android = uiSnapshotProvider();
    const systemOpen = vi.fn(() => Promise.resolve(system));
    const androidOpen = vi.fn(() => Promise.resolve(android));
    const auto = new AutoUiSnapshotProviderFactory(
      { open: systemOpen },
      { open: androidOpen }
    );

    await expect(auto.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 1000,
      backend: "android-cli"
    })).resolves.toBe(android);
    expect(systemOpen).not.toHaveBeenCalled();
    expect(androidOpen).toHaveBeenCalledOnce();
  });

  it("fails closed when explicitly selecting an unavailable Appium backend", async () => {
    const auto = new AutoUiSnapshotProviderFactory(
      { open: vi.fn() },
      { open: vi.fn() }
    );

    await expect(auto.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 1000,
      backend: "appium-uiautomator2"
    })).rejects.toMatchObject({
      code: "UI_BACKEND_UNAVAILABLE",
      backendId: "appium-uiautomator2"
    });
  });

  it("does not auto-fallback when the System UIAutomator probe times out", async () => {
    const runner = processRunner();
    vi.mocked(runner.run).mockResolvedValue(commandResult());
    vi.mocked(runner.run)
      .mockResolvedValueOnce(environmentResults()[0])
      .mockResolvedValueOnce(environmentResults()[1])
      .mockResolvedValueOnce(environmentResults()[2])
      .mockResolvedValueOnce(commandResult({
        exitCode: null,
        timedOut: true
      }))
      .mockResolvedValueOnce(commandResult());
    const androidOpen = vi.fn<UiSnapshotProviderFactory["open"]>(() => (
      Promise.resolve(uiSnapshotProvider())
    ));
    const auto = new AutoUiSnapshotProviderFactory(
      new SystemUiAutomatorSnapshotProviderFactory(runner),
      { open: androidOpen }
    );

    await expect(auto.open({
      deviceSerial: "emulator-5554",
      timeoutMs: 1000
    })).rejects.toMatchObject({ code: "UI_SNAPSHOT_FAILED" });
    expect(androidOpen).not.toHaveBeenCalled();
  });

  it("makes close idempotent and rejects capture after close", async () => {
    const runner = processRunner();
    const source = JSON.stringify({
      id: "root",
      enabled: true,
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      children: []
    });
    vi.mocked(runner.run)
      .mockResolvedValueOnce(environmentResults()[0])
      .mockResolvedValueOnce(environmentResults()[1])
      .mockResolvedValueOnce(environmentResults()[2])
      .mockResolvedValueOnce(commandResult({ stdout: source }));
    const provider = await new AndroidCliSnapshotProviderFactory(runner).open({
      deviceSerial: "emulator-5554",
      timeoutMs: 5000
    });

    await provider.close();
    await provider.close();
    await expect(provider.capture({
      reason: "observe",
      timeoutMs: 1000
    })).rejects.toMatchObject({ code: "UI_SNAPSHOT_FAILED" });
  });
});
