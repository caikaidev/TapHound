import { describe, expect, it, vi } from "vitest";

import {
  AppiumUiSnapshotProviderFactory,
  type AppiumHttpClient
} from "../../../src/adapters/appium/appium-ui-snapshot-provider.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

describe("AppiumUiSnapshotProvider", () => {
  it("creates a non-launching device session and normalizes Appium page source", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult({ stdout: "36\n" }))
      .mockResolvedValueOnce(commandResult({ stdout: "Physical size: 1080x1920\n" }))
      .mockResolvedValueOnce(commandResult({ stdout: "SurfaceOrientation: 0\n" }));
    const request = vi.fn<AppiumHttpClient["request"]>()
      .mockResolvedValueOnce({ value: { build: { version: "3.3.0" } } })
      .mockResolvedValueOnce({ value: { sessionId: "session-1" } })
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({ value: [
        '<?xml version="1.0"?><hierarchy>',
        '<android.widget.FrameLayout resource-id="com.example:id/root" enabled="true" bounds="[0,0][1080,1920]">',
        '<android.widget.TextView resource-id="compose_tag" text="Hello" clickable="true" enabled="true" bounds="[10,20][110,70]"/>',
        '</android.widget.FrameLayout></hierarchy>'
      ].join("") })
      .mockResolvedValueOnce({ value: [
        '<?xml version="1.0"?><hierarchy>',
        '<android.widget.FrameLayout resource-id="com.example:id/root" enabled="true" bounds="[0,0][1080,1920]">',
        '<android.widget.TextView resource-id="compose_tag" text="Hello" clickable="true" enabled="true" bounds="[10,20][110,70]"/>',
        '</android.widget.FrameLayout></hierarchy>'
      ].join("") })
      .mockResolvedValueOnce({ value: null });
    const factory = new AppiumUiSnapshotProviderFactory(
      runner,
      { request },
      { endpoint: "http://127.0.0.1:4723", mapTestTagToResourceId: true }
    );

    const provider = await factory.open({
      deviceSerial: "SM02G4061928151",
      timeoutMs: 5000,
      backend: "appium-uiautomator2"
    });
    const snapshot = await provider.capture({
      reason: "locate",
      timeoutMs: 1000
    });

    expect(request.mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      path: "/session",
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:udid": "SM02G4061928151",
            "appium:noReset": true,
            "appium:autoLaunch": false,
            "appium:autoGrantPermissions": false,
            "appium:fullReset": false,
            "appium:shouldTerminateApp": false
          }
        }
      }
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      path: "/session/session-1/appium/settings",
      body: { settings: { mapTestTagToResourceId: true } }
    });
    expect(snapshot).toMatchObject({
      backend: { id: "appium-uiautomator2", engineVersion: "3.3.0" },
      roots: [{
        resourceId: "root",
        children: [{ resourceId: "compose_tag", text: "Hello" }]
      }]
    });

    await provider.close();
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "DELETE",
      path: "/session/session-1"
    });
  });

  it("rejects non-loopback endpoints", () => {
    expect(() => new AppiumUiSnapshotProviderFactory(
      processRunner(),
      { request: vi.fn() },
      { endpoint: "https://appium.example.com" }
    )).toThrow(/loopback/i);
  });

  it("closes a provisional session when applying settings fails", async () => {
    const runner = processRunner();
    vi.mocked(runner.run)
      .mockResolvedValueOnce(commandResult({ stdout: "36\n" }))
      .mockResolvedValueOnce(commandResult({ stdout: "Physical size: 1080x1920\n" }))
      .mockResolvedValueOnce(commandResult({ stdout: "SurfaceOrientation: 0\n" }));
    const request = vi.fn<AppiumHttpClient["request"]>()
      .mockResolvedValueOnce({ value: { build: { version: "3.3.0" } } })
      .mockResolvedValueOnce({ value: { sessionId: "session-1" } })
      .mockRejectedValueOnce(new Error("settings rejected"))
      .mockResolvedValueOnce({ value: null });
    const factory = new AppiumUiSnapshotProviderFactory(runner, { request });

    await expect(factory.open({
      deviceSerial: "SM02G4061928151",
      timeoutMs: 5000,
      backend: "appium-uiautomator2"
    })).rejects.toMatchObject({ code: "UI_BACKEND_UNAVAILABLE" });
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "DELETE",
      path: "/session/session-1"
    });
  });
});
