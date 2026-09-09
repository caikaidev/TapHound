import { describe, expect, it } from "vitest";

import {
  FAKE_RUNTIME_ADAPTER_VERSION,
  FakeRuntimeBackend,
  FakeRuntimeSession,
  fakeRuntimeCapabilities,
  fakeRuntimeUiSnapshotProvider
} from "../../../src/adapters/runtime/fake-runtime-backend.js";
import {
  describeRuntimeBackendContract,
  type RuntimeBackendContractFixture
} from "./runtime-backend.contract.js";

describeRuntimeBackendContract("FakeRuntimeBackend", (): RuntimeBackendContractFixture => ({
  backend: new FakeRuntimeBackend(),
  deviceSerial: "emulator-5554",
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity"
}));

describe("FakeRuntimeBackend", () => {
  it("identifies itself through the adapter version", () => {
    const backend = new FakeRuntimeBackend();
    expect(backend.descriptor.adapterVersion)
      .toBe(FAKE_RUNTIME_ADAPTER_VERSION);
    expect(backend.descriptor.configSha256).toMatch(/^[a-f\d]{64}$/);
  });

  it("declares a reduced capability set by default", () => {
    expect(fakeRuntimeCapabilities()).toEqual({
      layoutSnapshot: true,
      screenshot: true,
      annotatedScreens: false,
      frameStatsIdle: false,
      logs: true,
      processDiscovery: true,
      windowTopology: false,
      intentStart: false,
      foregroundActivity: false
    });
  });

  it("records openSession options", async () => {
    const backend = new FakeRuntimeBackend();
    await backend.openSession({ deviceSerial: "serial-1" });
    expect(backend.openCalls).toEqual([{ deviceSerial: "serial-1" }]);
  });

  it("supports custom session creation", async () => {
    const custom = new FakeRuntimeSession({
      descriptor: new FakeRuntimeBackend().descriptor,
      deviceSerial: "serial-2"
    });
    const backend = new FakeRuntimeBackend({
      sessions: (): FakeRuntimeSession => custom
    });
    const session = await backend.openSession({ deviceSerial: "serial-2" });
    expect(session).toBe(custom);
  });

  it("leaves capability-gated members undefined by default", async () => {
    const backend = new FakeRuntimeBackend();
    const session = await backend.openSession({ deviceSerial: "serial-1" });
    expect(session.annotatedScreens).toBeUndefined();
    expect(session.startActivityByIntent).toBeUndefined();
    expect(session.uiStability).toBeDefined();
    await expect(session.uiStability.sample({
      deviceSerial: "serial-1"
    })).resolves.toEqual([]);
  });

  it("records session calls for assertions", async () => {
    const session = new FakeRuntimeSession({
      descriptor: new FakeRuntimeBackend().descriptor,
      deviceSerial: "serial-1"
    });
    await session.tap({ x: 1, y: 2 });
    await session.back();
    await session.inputText("hello");
    await session.close();
    expect(session.calls).toEqual([
      "tap:1,2",
      "back",
      "inputText:hello",
      "close"
    ]);
  });

  it("serves configurable app state", async () => {
    const backend = new FakeRuntimeBackend({
      capabilities: { ...fakeRuntimeCapabilities(), foregroundActivity: true }
    });
    const session = new FakeRuntimeSession({
      descriptor: backend.descriptor,
      deviceSerial: "serial-1",
      state: {
        installed: false,
        currentActivity: "com.example.app.CustomActivity"
      }
    });
    await expect(session.isInstalled({ packageName: "com.example.app" }))
      .resolves.toBe(false);
    await expect(session.currentActivity?.({ packageName: "com.example.app" }))
      .resolves.toBe("com.example.app.CustomActivity");
  });

  it("gates optional members behind declared capabilities", () => {
    const backend = new FakeRuntimeBackend();
    const session = new FakeRuntimeSession({
      descriptor: backend.descriptor,
      deviceSerial: "serial-1"
    });
    expect(session.currentActivity).toBeUndefined();
    expect(session.foregroundComponent).toBeUndefined();
    expect(session.windowTopology).toBeUndefined();
    expect(session.appProcesses).toBeDefined();
    expect(session.startLogcat).toBeDefined();
    expect(session.dumpLogcat).toBeDefined();
  });

  it("wraps a default snapshot provider", async () => {
    const provider = fakeRuntimeUiSnapshotProvider();
    const session = new FakeRuntimeSession({
      descriptor: new FakeRuntimeBackend().descriptor,
      deviceSerial: "serial-1",
      uiSnapshots: provider
    });
    await expect(session.openUiSnapshots()).resolves.toBe(provider);
    await expect(session.openUiSnapshots()).resolves.toBe(provider);
    const snapshot = await provider.capture({
      reason: "locate",
      timeoutMs: 1000
    });
    expect(snapshot.backend.id).toBe("system-uiautomator");
    expect(snapshot.roots).toEqual([]);
  });
});
