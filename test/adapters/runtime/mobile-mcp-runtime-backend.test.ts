import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MobileMcpRuntimeBackend,
  MobileMcpRuntimeSession,
  MOBILE_MCP_RUNTIME_ADAPTER_VERSION,
  MOBILE_MCP_UI_ADAPTER_VERSION,
  mobileMcpRuntimeCapabilities,
  mobileMcpUiBackendDescriptor
} from "../../../src/adapters/runtime/mobile-mcp/mobile-mcp-runtime-backend.js";
import {
  assertMobileMcpToolText,
  mapMobileMcpElement,
  mapMobileMcpSwipe,
  mobileMcpSwipeResponse,
  parseMobileMcpAppPackages,
  parseMobileMcpDevices,
  parseMobileMcpElements,
  parseMobileMcpScreenSize
} from "../../../src/adapters/runtime/mobile-mcp/mobile-mcp-responses.js";
import { MobileMcpToolError } from "../../../src/adapters/runtime/mobile-mcp/mobile-mcp-errors.js";
import { McpToolClient, defaultToolEnv } from "../../../src/adapters/runtime/mobile-mcp/mcp-tool-client.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  MobileMcpDeviceEntry,
  MobileMcpElement
} from "../../../src/adapters/runtime/mobile-mcp/mobile-mcp-tools.js";
import { UiSnapshotError } from "../../../src/adapters/ui/ui-snapshot-error.js";
import {
  FakeMobileMcpTools,
  FAKE_MOBILE_MCP_ELEMENTS
} from "../../fakes/mobile-mcp-tools.js";
import { FakeMcpTransport } from "../../fakes/mcp-transport.js";
import {
  describeRuntimeBackendContract,
  type RuntimeBackendContractFixture
} from "./runtime-backend.contract.js";

function mobileMcpFixture(): {
  backend: MobileMcpRuntimeBackend;
  tools: FakeMobileMcpTools;
} {
  const tools = new FakeMobileMcpTools();
  const backend = new MobileMcpRuntimeBackend({
    createTools: (): FakeMobileMcpTools => tools
  });
  return { backend, tools };
}

async function openFakeSession(): Promise<{
  session: MobileMcpRuntimeSession;
  tools: FakeMobileMcpTools;
}> {
  const tools = new FakeMobileMcpTools();
  const backend = new MobileMcpRuntimeBackend({
    createTools: (): FakeMobileMcpTools => tools
  });
  const session = await backend.openSession({
    deviceSerial: "emulator-5554"
  });
  return { session: session as MobileMcpRuntimeSession, tools };
}

describeRuntimeBackendContract(
  "MobileMcpRuntimeBackend",
  (): RuntimeBackendContractFixture => {
    const { backend } = mobileMcpFixture();
    return {
      backend,
      deviceSerial: "emulator-5554",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    };
  }
);

describe("mobile-mcp responses", () => {
  it("parses the device listing payload", () => {
    const devices = parseMobileMcpDevices(JSON.stringify({
      devices: [
        {
          id: "R5CX9180DPJ",
          name: "Galaxy A55",
          platform: "android",
          type: "real",
          version: "14",
          state: "online"
        },
        { id: "ios-sim", platform: "ios", state: "online" }
      ]
    }));
    expect(devices).toHaveLength(2);
    expect(devices[0]?.id).toBe("R5CX9180DPJ");
    expect(devices[0]?.platform).toBe("android");
    expect(devices[1]?.name).toBeUndefined();
  });

  it("rejects malformed device listings", () => {
    expect(() => parseMobileMcpDevices("not json")).toThrow(
      MobileMcpToolError
    );
    expect(() => parseMobileMcpDevices("{}")).toThrow(MobileMcpToolError);
    expect(() => parseMobileMcpDevices("{\"devices\":[{\"id\":1}]}"))
      .toThrow(MobileMcpToolError);
  });

  it("parses the screen size response", () => {
    expect(parseMobileMcpScreenSize("Screen size is 1080x2340 pixels"))
      .toEqual({ width: 1080, height: 2340 });
    expect(() => parseMobileMcpScreenSize("Screen size is 1080x0 pixels"))
      .toThrow(MobileMcpToolError);
    expect(() => parseMobileMcpScreenSize("some other text"))
      .toThrow(MobileMcpToolError);
  });

  it("parses the on-screen element payload", () => {
    const elements = parseMobileMcpElements(
      `Found these elements on screen: ${JSON.stringify([
        {
          type: "android.widget.Button",
          text: "Sign in",
          label: "Sign in button",
          identifier: "com.example.app:id/sign_in",
          coordinates: { x: 100, y: 400, width: 400, height: 120 },
          focused: true
        },
        {
          type: "android.widget.EditText",
          label: "Username",
          coordinates: { x: 100, y: 600, width: 400, height: 100 }
        }
      ])}`
    );
    expect(elements).toHaveLength(2);
    expect(elements[0]?.identifier).toBe("com.example.app:id/sign_in");
    expect(elements[0]?.focused).toBe(true);
    expect(elements[1]?.identifier).toBeUndefined();
  });

  it("rejects malformed element payloads", () => {
    expect(() => parseMobileMcpElements("nothing on screen"))
      .toThrow(MobileMcpToolError);
    expect(
      () => parseMobileMcpElements("Found these elements on screen: {")
    ).toThrow(MobileMcpToolError);
    expect(
      () => parseMobileMcpElements("Found these elements on screen: {}")
    ).toThrow(MobileMcpToolError);
    expect(
      () => parseMobileMcpElements(
        "Found these elements on screen: [{\"coordinates\":\"bad\"}]"
      )
    ).toThrow(MobileMcpToolError);
  });

  it("extracts android package names from the app listing", () => {
    expect(parseMobileMcpAppPackages(
      "Found these apps on device: Example App (com.example.app), Settings (com.android.settings)"
    )).toEqual(["com.example.app", "com.android.settings"]);
    expect(parseMobileMcpAppPackages(
      "Found these apps on device: Beta (beta) (com.example.beta)"
    )).toEqual(["com.example.beta"]);
    expect(parseMobileMcpAppPackages("Found these apps on device: "))
      .toEqual([]);
  });

  it("maps mobile-mcp elements onto layout elements", () => {
    const element: MobileMcpElement = {
      type: "android.widget.Button",
      text: "Sign in",
      label: "Sign in button",
      identifier: "com.example.app:id/sign_in",
      coordinates: { x: 100, y: 400, width: 400, height: 120 },
      focused: true
    };
    expect(mapMobileMcpElement(element, 3)).toEqual({
      id: "mobile-mcp-3",
      resourceId: "sign_in",
      text: "Sign in",
      contentDescription: "Sign in button",
      focused: true,
      enabled: true,
      bounds: { left: 100, top: 400, right: 500, bottom: 520 },
      center: { x: 300, y: 460 },
      children: []
    });
  });

  it("maps swipes onto direction, distance, and origin", () => {
    expect(mapMobileMcpSwipe({ x: 10, y: 20 }, { x: 10, y: 60 })).toEqual({
      direction: "down",
      x: 10,
      y: 20,
      distance: 40
    });
    expect(mapMobileMcpSwipe({ x: 10, y: 60 }, { x: 10, y: 20 })).toEqual({
      direction: "up",
      x: 10,
      y: 60,
      distance: 40
    });
    expect(mapMobileMcpSwipe({ x: 10, y: 20 }, { x: 110, y: 25 })).toEqual({
      direction: "right",
      x: 10,
      y: 20,
      distance: 100
    });
    expect(mapMobileMcpSwipe({ x: 110, y: 20 }, { x: 10, y: 25 })).toEqual({
      direction: "left",
      x: 110,
      y: 20,
      distance: 100
    });
    expect(() => mapMobileMcpSwipe({ x: 5, y: 5 }, { x: 5, y: 5 }))
      .toThrow(MobileMcpToolError);
  });

  it("validates action response text", () => {
    expect((): void => {
      assertMobileMcpToolText("mobile_launch_app", "Launched app com.example.app", "Launched app com.example.app");
    }).not.toThrow();
    expect((): void => {
      assertMobileMcpToolText("mobile_launch_app", "boom", "Launched app com.example.app");
    }).toThrow(MobileMcpToolError);
  });

  it("builds the expected swipe response text", () => {
    expect(mobileMcpSwipeResponse({
      direction: "down",
      x: 10,
      y: 20,
      distance: 50
    })).toBe("Swiped down 50 pixels from coordinates: 10, 20");
  });
});

describe("MobileMcpRuntimeBackend", () => {
  it("declares mobile-mcp identity and reduced capabilities", () => {
    const { backend } = mobileMcpFixture();
    expect(backend.descriptor.id).toBe("mobile-mcp");
    expect(backend.descriptor.adapterVersion)
      .toBe(MOBILE_MCP_RUNTIME_ADAPTER_VERSION);
    expect(backend.descriptor.engineVersion).toBeUndefined();
    expect(backend.capabilities).toEqual(mobileMcpRuntimeCapabilities());
    expect(backend.capabilities).toEqual({
      layoutSnapshot: true,
      screenshot: true,
      annotatedScreens: false,
      frameStatsIdle: false,
      logs: false,
      processDiscovery: false,
      windowTopology: false,
      intentStart: false,
      foregroundActivity: false
    });
  });

  it("binds the engine version into the descriptor when provided", () => {
    const backend = new MobileMcpRuntimeBackend({
      createTools: (): FakeMobileMcpTools => new FakeMobileMcpTools(),
      engineVersion: "1.0.2"
    });
    expect(backend.descriptor.engineVersion).toBe("1.0.2");
    const plain = new MobileMcpRuntimeBackend({
      createTools: (): FakeMobileMcpTools => new FakeMobileMcpTools()
    });
    expect(plain.descriptor.configSha256)
      .not.toBe(backend.descriptor.configSha256);
  });

  it("lists only online android devices", async () => {
    const devices: readonly MobileMcpDeviceEntry[] = [
      {
        id: "serial-1",
        platform: "android",
        state: "online"
      },
      {
        id: "serial-2",
        platform: "android",
        state: "offline"
      },
      {
        id: "sim-1",
        platform: "ios",
        state: "online"
      }
    ];
    const tools = new FakeMobileMcpTools({ devices });
    const backend = new MobileMcpRuntimeBackend({
      createTools: (): FakeMobileMcpTools => tools
    });
    await expect(backend.listDevices()).resolves.toEqual([
      { serial: "serial-1", status: "device" }
    ]);
    expect(tools.closed).toBe(true);
  });

  it("opens sessions without issuing tool calls", async () => {
    const { backend, tools } = mobileMcpFixture();
    const session = await backend.openSession({ deviceSerial: "serial-9" });
    expect(session.deviceSerial).toBe("serial-9");
    expect(session.descriptor).toBe(backend.descriptor);
    expect(tools.calls).toEqual([]);
    expect(tools.closed).toBe(false);
    await session.close();
  });
});

describe("MobileMcpRuntimeSession", () => {
  it("leaves capability-gated members undefined", async () => {
    const { session } = await openFakeSession();
    expect(session.annotatedScreens).toBeUndefined();
    expect(session.startActivityByIntent).toBeUndefined();
    expect(session.currentActivity).toBeUndefined();
    expect(session.foregroundComponent).toBeUndefined();
    expect(session.appProcesses).toBeUndefined();
    expect(session.windowTopology).toBeUndefined();
    expect(session.startLogcat).toBeUndefined();
    expect(session.dumpLogcat).toBeUndefined();
    await session.close();
  });

  it("answers installation queries from the app listing", async () => {
    const { session, tools } = await openFakeSession();
    await expect(session.isInstalled({ packageName: "com.example.app" }))
      .resolves.toBe(true);
    await expect(session.isInstalled({ packageName: "com.missing.app" }))
      .resolves.toBe(false);
    expect(tools.calls).toContain("listApps:emulator-5554");
    await session.close();
  });

  it("resolves launch, terminate, and actions as command results", async () => {
    const { session, tools } = await openFakeSession();
    const launch = await session.launchApp({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    });
    expect(launch.exitCode).toBe(0);
    expect(launch.stdout).toBe("Launched app com.example.app");
    expect(await session.forceStop({ packageName: "com.example.app" }))
      .toMatchObject({ exitCode: 0, stdout: "Terminated app com.example.app" });
    expect(await session.tap({ x: 10, y: 20 }))
      .toMatchObject({ exitCode: 0 });
    expect(await session.longClick({ x: 10, y: 20 }, 800))
      .toMatchObject({ exitCode: 0 });
    expect(await session.back()).toMatchObject({ exitCode: 0 });
    expect(await session.inputText("hello"))
      .toMatchObject({ exitCode: 0, stdout: "Typed text: hello" });
    expect(tools.calls).toContain("launchApp:emulator-5554:com.example.app");
    expect(tools.calls).toContain("tap:emulator-5554:10,20");
    expect(tools.calls)
      .toContain("longPress:emulator-5554:10,20:800");
    expect(tools.calls).toContain("pressButton:emulator-5554:BACK");
    expect(tools.calls).toContain("typeKeys:emulator-5554:hello:false");
    await session.close();
  });

  it("maps swipes onto direction and distance", async () => {
    const { session, tools } = await openFakeSession();
    const result = await session.swipe(
      { x: 10, y: 20 },
      { x: 10, y: 60 },
      300
    );
    expect(result.exitCode).toBe(0);
    expect(tools.calls).toContain("swipe:emulator-5554:down:10,20:40");
    await session.close();
  });

  it("fails actions closed when the tool response is unexpected", async () => {
    const { session, tools } = await openFakeSession();
    tools.launchApp = (): Promise<string> =>
      Promise.resolve("something unexpected");
    const result = await session.launchApp({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unexpected response");
    await session.close();
  });

  it("fails actions closed when the tool errors", async () => {
    const { session: failing, tools } = await openFakeSession();
    tools.typeKeys = (): Promise<string> =>
      Promise.reject(new MobileMcpToolError("mobile_type_keys", "boom"));
    const failed = await failing.inputText("hello");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe("boom");
    await failing.close();
  });

  it("rejects long press durations outside the supported range", async () => {
    const { session, tools } = await openFakeSession();
    const tooShort = await session.longClick({ x: 10, y: 20 }, 0);
    expect(tooShort.exitCode).toBe(1);
    const tooLong = await session.longClick({ x: 10, y: 20 }, 20_000);
    expect(tooLong.exitCode).toBe(1);
    expect(tools.calls.filter((call): boolean =>
      call.startsWith("longPress"))).toEqual([]);
    await session.close();
  });

  it("rejects swipes without movement", async () => {
    const { session, tools } = await openFakeSession();
    const result = await session.swipe({ x: 5, y: 5 }, { x: 5, y: 5 }, 300);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("swipe requires movement");
    expect(tools.calls.filter((call): boolean =>
      call.startsWith("swipe"))).toEqual([]);
    await session.close();
  });

  it("captures screenshots through a temporary file", async () => {
    const { session, tools } = await openFakeSession();
    const destinationDir = await mkdtemp(join(tmpdir(), "taphound-shot-"));
    const outputPath = join(destinationDir, "nested", "screen.png");
    try {
      const result = await session.captureScreenshot({ outputPath });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Screenshot saved to: ${outputPath}`);
      const saveCall = tools.calls.find((call): boolean =>
        call.startsWith("saveScreenshot:"));
      expect(saveCall).toBeDefined();
      const tempPath = saveCall?.split(":").slice(2).join(":");
      expect(tempPath).toContain(tmpdir());
      expect(tempPath).not.toBe(outputPath);
      await expect(readFile(outputPath, "utf8"))
        .resolves.toBe("fake-png-bytes");
    } finally {
      await rm(destinationDir, { recursive: true, force: true });
      await session.close();
    }
  });

  it("fails screenshot capture closed when annotation is requested", async () => {
    const { session, tools } = await openFakeSession();
    const result = await session.captureScreenshot({
      outputPath: "screen.png",
      annotate: true
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot annotate");
    expect(tools.calls).toEqual([]);
    await session.close();
  });

  it("fails screenshot capture closed for unsupported extensions", async () => {
    const { session, tools } = await openFakeSession();
    const result = await session.captureScreenshot({
      outputPath: "screen.txt"
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("screenshot output must end with");
    expect(tools.calls).toEqual([]);
    await session.close();
  });

  it("samples layout stability with signatures", async () => {
    const { session, tools } = await openFakeSession();
    const observe = async (): Promise<{
      changes: readonly unknown[];
      backend?: string;
    }> => {
      const result = await session.uiStability.sample({
        deviceSerial: "emulator-5554"
      });
      if (Array.isArray(result)) {
        throw new Error("expected a stability observation");
      }
      return result as { changes: readonly unknown[]; backend?: string };
    };
    const first = await observe();
    expect(first.changes).toHaveLength(1);
    expect(first.backend).toBe("mobileMcp");
    const second = await observe();
    expect(second.changes).toEqual([]);
    tools.elements = [...FAKE_MOBILE_MCP_ELEMENTS, {
      type: "android.widget.Button",
      text: "New",
      coordinates: { x: 0, y: 0, width: 10, height: 10 }
    }];
    const third = await observe();
    expect(third.changes).toHaveLength(1);
    session.uiStability.reset();
    const fourth = await observe();
    expect(fourth.changes).toHaveLength(1);
    await session.close();
  });

  it("opens the snapshot provider lazily with a mobile-mcp descriptor", async () => {
    const { session } = await openFakeSession();
    const provider = await session.openUiSnapshots({ timeoutMs: 1500 });
    const again = await session.openUiSnapshots({ timeoutMs: 2000 });
    expect(again).toBe(provider);
    expect(provider.descriptor).toEqual({
      id: "mobile-mcp",
      adapterVersion: MOBILE_MCP_UI_ADAPTER_VERSION,
      engineVersion: "1.0.2",
      configSha256: mobileMcpUiBackendDescriptor("1.0.2").configSha256
    });
    const snapshot = await provider.capture({
      reason: "locate",
      timeoutMs: 5000
    });
    expect(snapshot.backend).toEqual(provider.descriptor);
    expect(snapshot.viewport).toEqual({
      width: 1080,
      height: 2340,
      rotation: 0,
      coordinateSpace: "physicalDisplayPixels"
    });
    expect(snapshot.roots).toHaveLength(3);
    expect(snapshot.roots[1]?.resourceId).toBe("sign_in");
    expect(snapshot.roots[1]?.contentDescription).toBe("Sign in button");
    expect(snapshot.roots[1]?.focused).toBe(true);
    expect(snapshot.roots[1]?.enabled).toBe(true);
    expect(snapshot.roots[1]?.bounds).toEqual({
      left: 100,
      top: 400,
      right: 500,
      bottom: 520
    });
    expect(snapshot.roots[1]?.center).toEqual({ x: 300, y: 460 });
    expect(snapshot.roots[1]?.clickable).toBeUndefined();
    expect(snapshot.observationId.length).toBeGreaterThan(0);
    await session.close();
  });

  it("rejects explicit ui backend selections", async () => {
    const { session } = await openFakeSession();
    await expect(session.openUiSnapshots({
      backend: "system-uiautomator"
    })).rejects.toThrow(UiSnapshotError);
    await session.close();
  });

  it("accepts the auto ui backend selection", async () => {
    const { session } = await openFakeSession();
    const provider = await session.openUiSnapshots({ backend: "auto" });
    expect(provider.descriptor.id).toBe("mobile-mcp");
    await session.close();
  });

  it("wraps provider open failures as snapshot errors", async () => {
    const tools = new FakeMobileMcpTools();
    tools.getScreenSize = (): Promise<string> =>
      Promise.reject(new Error("device exploded"));
    const backend = new MobileMcpRuntimeBackend({
      createTools: (): FakeMobileMcpTools => tools
    });
    const session = await backend.openSession({ deviceSerial: "serial-1" });
    await expect(session.openUiSnapshots()).rejects.toThrow(UiSnapshotError);
    await session.close();
  });

  it("invalidates the memoized provider after an open failure", async () => {
    const tools = new FakeMobileMcpTools();
    let failing = true;
    tools.getScreenSize = (): Promise<string> => failing
      ? Promise.reject(new Error("not yet"))
      : Promise.resolve("Screen size is 1080x2340 pixels");
    const backend = new MobileMcpRuntimeBackend({
      createTools: (): FakeMobileMcpTools => tools
    });
    const session = await backend.openSession({ deviceSerial: "serial-1" });
    await expect(session.openUiSnapshots()).rejects.toThrow(UiSnapshotError);
    failing = false;
    await expect(session.openUiSnapshots()).resolves.toBeDefined();
    await session.close();
  });

  it("captures no snapshots from a closed provider", async () => {
    const { session } = await openFakeSession();
    const provider = await session.openUiSnapshots();
    await session.close();
    await expect(provider.capture({
      reason: "locate",
      timeoutMs: 1000
    })).rejects.toThrow(UiSnapshotError);
  });

  it("closes the tools connection on session close", async () => {
    const { session, tools } = await openFakeSession();
    await session.openUiSnapshots();
    await session.close();
    expect(tools.closed).toBe(true);
  });
});

describe("McpToolClient", () => {
  function clientWithTransport(): {
    client: McpToolClient;
    transport: FakeMcpTransport;
  } {
    const transport = new FakeMcpTransport();
    const client = new McpToolClient({
      transportFactory: (): FakeMcpTransport => transport
    });
    return { client, transport };
  }

  it("connects lazily and reuses the connection", async () => {
    const { client, transport } = clientWithTransport();
    expect(transport.startCalls).toBe(0);
    transport.nextToolResult = { text: "{\"devices\":[]}" };
    await expect(client.listDevices()).resolves.toBe("{\"devices\":[]}");
    transport.nextToolResult = { text: "Screen size is 1x2 pixels" };
    await expect(client.getScreenSize("serial-1"))
      .resolves.toBe("Screen size is 1x2 pixels");
    expect(transport.startCalls).toBe(1);
    expect(transport.sent[0]?.method).toBe("initialize");
    const call = transport.sent.find((entry): boolean =>
      entry.method === "tools/call");
    expect(call?.params).toEqual({
      name: "mobile_list_available_devices",
      arguments: {}
    });
    await client.close();
  });

  it("forwards TMPDIR so the server temp allowlist covers TapHound temp paths", () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = "/var/folders/example/T/";
    try {
      expect(defaultToolEnv()).toMatchObject({
        MOBILEMCP_DISABLE_TELEMETRY: "1",
        TMPDIR: "/var/folders/example/T/"
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }
  });

  it("omits TMPDIR when the host environment does not set it", () => {
    const previous = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const env = defaultToolEnv();
      expect(env.MOBILEMCP_DISABLE_TELEMETRY).toBe("1");
      expect(env.TMPDIR).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env.TMPDIR = previous;
      }
    }
  });

  it("passes tool arguments through to the server", async () => {
    const { client, transport } = clientWithTransport();
    transport.nextToolResult = { text: "Clicked on screen at coordinates: 10, 20" };
    await expect(client.tap("serial-1", 10, 20))
      .resolves.toBe("Clicked on screen at coordinates: 10, 20");
    const call = transport.sent.find((entry): boolean =>
      entry.method === "tools/call");
    expect(call?.params).toEqual({
      name: "mobile_click_on_screen_at_coordinates",
      arguments: { device: "serial-1", x: 10, y: 20 }
    });
    await client.close();
  });

  it("raises tool errors as MobileMcpToolError", async () => {
    const { client, transport } = clientWithTransport();
    transport.nextToolResult = { text: "Error: device not found", isError: true };
    const failure = client.listDevices();
    await expect(failure).rejects.toThrow(MobileMcpToolError);
    await expect(failure).rejects.toThrow("Error: device not found");
    await client.close();
  });

  it("exposes the server version once connected", async () => {
    const { client, transport } = clientWithTransport();
    expect(client.serverVersion()).toBeUndefined();
    transport.nextToolResult = { text: "{}" };
    await client.listDevices();
    expect(client.serverVersion()).toBe("9.9.9");
    await client.close();
  });

  it("closes the underlying connection", async () => {
    const { client, transport } = clientWithTransport();
    transport.nextToolResult = { text: "{}" };
    await client.listDevices();
    await client.close();
    expect(transport.closeCalls).toBe(1);
    await expect(client.listDevices()).rejects.toThrow("closed");
  });

  function clientWithFailingTransport(failure: Error): McpToolClient {
    const transport: Transport = {
      start: (): Promise<void> => Promise.reject(failure),
      send: (): Promise<void> => Promise.resolve(),
      close: (): Promise<void> => Promise.resolve()
    };
    return new McpToolClient({
      transportFactory: (): Transport => transport
    });
  }

  it("explains how to install the server when the spawn fails", async () => {
    const failure = Object.assign(
      new Error("spawn mcp-server-mobile ENOENT"),
      { code: "ENOENT" }
    );
    const client = clientWithFailingTransport(failure);
    const rejection = await client.listDevices().then(
      () => undefined,
      (error: unknown): unknown => error
    ) as { code?: unknown; message?: unknown };
    expect(rejection.code).toBe("ENVIRONMENT_MISSING_TOOL");
    expect(rejection.message).toContain("npm install -g @mobilenext/mobile-mcp");
    expect(rejection.message).toContain("TAPHOUND_RUNTIME_BACKEND");
    expect(rejection.message).toContain("spawn mcp-server-mobile ENOENT");
  });

  it("explains how to fix an unusable server binary", async () => {
    const failure = Object.assign(
      new Error("spawn mcp-server-mobile EACCES"),
      { code: "EACCES" }
    );
    const client = clientWithFailingTransport(failure);
    const rejection = await client.listDevices().then(
      () => undefined,
      (error: unknown): unknown => error
    ) as { code?: unknown; message?: unknown };
    expect(rejection.code).toBe("ENVIRONMENT_MISSING_TOOL");
    expect(rejection.message).toContain("npm install -g @mobilenext/mobile-mcp");
  });

  it("codes handshake failures as environment failures with context", async () => {
    const client = clientWithFailingTransport(
      new Error("server closed the stream")
    );
    const rejection = await client.listDevices().then(
      () => undefined,
      (error: unknown): unknown => error
    ) as { code?: unknown; message?: unknown };
    expect(rejection.code).toBe("ENVIRONMENT_MISSING_TOOL");
    expect(rejection.message).toContain("mcp-server-mobile");
    expect(rejection.message).toContain("server closed the stream");
    expect(rejection.message).not.toContain("npm install");
  });
});
