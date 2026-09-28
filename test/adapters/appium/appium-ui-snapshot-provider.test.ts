import { describe, expect, it, vi } from "vitest";

import {
  AppiumHttpError,
  AppiumUiSnapshotProviderFactory,
  type AppiumHttpClient,
  type AppiumHttpRequest
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

  describe("degraded session recovery", () => {
    const pageSource = [
      '<?xml version="1.0"?><hierarchy>',
      '<android.widget.FrameLayout resource-id="com.example:id/root" enabled="true" bounds="[0,0][1080,1920]"/>',
      "</hierarchy>"
    ].join("");
    const timeout = (): DOMException => new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );

    /** Routes requests by path; `sourceFailures` fail the next source reads. */
    function appium(sourceFailures: (Error | undefined)[]): {
      request: ReturnType<typeof vi.fn<AppiumHttpClient["request"]>>;
      calls: () => string[];
    } {
      let sessions = 0;
      const request = vi.fn<AppiumHttpClient["request"]>((input: AppiumHttpRequest) => {
        if (input.path === "/status") {
          return Promise.resolve({ value: { build: { version: "3.3.0" } } });
        }
        if (input.method === "POST" && input.path === "/session") {
          sessions += 1;
          return Promise.resolve({ value: { sessionId: `session-${String(sessions)}` } });
        }
        if (input.path.endsWith("/source")) {
          const failure = sourceFailures.shift();
          return failure === undefined
            ? Promise.resolve({ value: pageSource })
            : Promise.reject(failure);
        }
        return Promise.resolve({ value: null });
      });
      return {
        request,
        calls: () => request.mock.calls.map(([input]) => `${input.method} ${input.path}`)
      };
    }

    async function openProvider(request: AppiumHttpClient["request"]): Promise<
      Awaited<ReturnType<AppiumUiSnapshotProviderFactory["open"]>>
    > {
      const runner = processRunner();
      vi.mocked(runner.run)
        .mockResolvedValueOnce(commandResult({ stdout: "36\n" }))
        .mockResolvedValueOnce(commandResult({ stdout: "Physical size: 1080x1920\n" }))
        .mockResolvedValueOnce(commandResult({ stdout: "SurfaceOrientation: 0\n" }));
      return new AppiumUiSnapshotProviderFactory(runner, { request }).open({
        deviceSerial: "SM02G4061928151",
        timeoutMs: 5000,
        backend: "appium-uiautomator2"
      });
    }

    it.each([
      ["a page source timeout", timeout()],
      ["an unknown session", new AppiumHttpError(404)]
    ])("recreates the session once after %s and keeps using it", async (_label, failure) => {
      const fake = appium([undefined, failure]);
      const provider = await openProvider(fake.request);

      const snapshot = await provider.capture({ reason: "idle", timeoutMs: 1000 });
      await provider.capture({ reason: "locate", timeoutMs: 1000 });
      await provider.close();

      expect(snapshot.roots).toMatchObject([{ resourceId: "root" }]);
      expect(fake.calls()).toEqual([
        "GET /status",
        "POST /session",
        "POST /session/session-1/appium/settings",
        "GET /session/session-1/source",
        "GET /session/session-1/source",
        "DELETE /session/session-1",
        "POST /session",
        "POST /session/session-2/appium/settings",
        "GET /session/session-2/source",
        "GET /session/session-2/source",
        "DELETE /session/session-2"
      ]);
    });

    it("fails with both causes when the retry on a fresh session also fails", async () => {
      const fake = appium([undefined, timeout(), timeout()]);
      const provider = await openProvider(fake.request);

      await expect(provider.capture({ reason: "idle", timeoutMs: 1000 }))
        .rejects.toMatchObject({
          code: "UI_SNAPSHOT_FAILED",
          message: expect.stringMatching(
            /timeout; retry on a recreated session failed: .*timeout/
          ) as unknown
        });
      expect(fake.calls().filter((call) => call === "POST /session")).toHaveLength(2);
    });

    it.each([
      ["a server error", new AppiumHttpError(500)],
      ["a transport error", new Error("socket hang up")]
    ])("does not retry %s", async (_label, failure) => {
      const fake = appium([undefined, failure]);
      const provider = await openProvider(fake.request);

      await expect(provider.capture({ reason: "idle", timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: "UI_SNAPSHOT_FAILED" });
      expect(fake.calls().filter((call) => call === "POST /session")).toHaveLength(1);
    });

    it("does not retry when the caller cancelled the capture", async () => {
      const fake = appium([undefined, timeout()]);
      const provider = await openProvider(fake.request);
      const controller = new AbortController();
      controller.abort();

      await expect(provider.capture({
        reason: "idle",
        timeoutMs: 1000,
        signal: controller.signal
      })).rejects.toMatchObject({ code: "UI_SNAPSHOT_FAILED" });
      expect(fake.calls().filter((call) => call === "POST /session")).toHaveLength(1);
    });
  });
});
