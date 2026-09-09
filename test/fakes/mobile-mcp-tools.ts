import { writeFileSync } from "node:fs";

import type {
  MobileMcpDeviceEntry,
  MobileMcpElement,
  MobileMcpToolCallOptions,
  MobileMcpTools,
  MobileMcpSwipeDirection
} from "../../src/adapters/runtime/mobile-mcp/mobile-mcp-tools.js";

export interface FakeMobileMcpToolsOptions {
  devices?: readonly MobileMcpDeviceEntry[] | undefined;
  screenSize?: { width: number; height: number } | undefined;
  elements?: readonly MobileMcpElement[] | undefined;
  apps?: readonly { appName: string; packageName: string }[] | undefined;
  serverVersion?: string | undefined;
  screenshotBytes?: string | undefined;
}

export const FAKE_MOBILE_MCP_DEVICE: MobileMcpDeviceEntry = {
  id: "emulator-5554",
  name: "Fake Android",
  platform: "android",
  type: "emulator",
  version: "14",
  state: "online",
  model: "Fake Model"
};

export const FAKE_MOBILE_MCP_SCREEN_SIZE = { width: 1080, height: 2340 };

export const FAKE_MOBILE_MCP_ELEMENTS: readonly MobileMcpElement[] = [
  {
    type: "android.widget.TextView",
    text: "Welcome",
    label: "",
    identifier: "com.example.app:id/title",
    coordinates: { x: 100, y: 200, width: 400, height: 80 }
  },
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
    text: "",
    label: "Username",
    identifier: "com.example.app:id/username",
    coordinates: { x: 100, y: 600, width: 400, height: 100 }
  }
];

export const FAKE_MOBILE_MCP_APPS: readonly {
  appName: string;
  packageName: string;
}[] = [
  { appName: "Example App", packageName: "com.example.app" },
  { appName: "Settings", packageName: "com.android.settings" }
];

export class FakeMobileMcpTools implements MobileMcpTools {
  public readonly calls: string[] = [];
  public closed = false;
  public connected = true;
  public readonly devices: readonly MobileMcpDeviceEntry[];
  public readonly screenSize: { width: number; height: number };
  public elements: readonly MobileMcpElement[];
  public readonly apps: readonly { appName: string; packageName: string }[];
  public readonly version: string;
  public readonly screenshotBytes: string;

  public constructor(options: FakeMobileMcpToolsOptions = {}) {
    this.devices = options.devices ?? [FAKE_MOBILE_MCP_DEVICE];
    this.screenSize = options.screenSize ?? FAKE_MOBILE_MCP_SCREEN_SIZE;
    this.elements = options.elements ?? FAKE_MOBILE_MCP_ELEMENTS;
    this.apps = options.apps ?? FAKE_MOBILE_MCP_APPS;
    this.version = options.serverVersion ?? "1.0.2";
    this.screenshotBytes = options.screenshotBytes ?? "fake-png-bytes";
  }

  private record(call: string, options?: MobileMcpToolCallOptions): void {
    this.calls.push(
      options?.signal === undefined ? call : `${call}:signalled`
    );
  }

  public listDevices(
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record("listDevices", options);
    return Promise.resolve(JSON.stringify({ devices: this.devices }));
  }

  public getScreenSize(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`getScreenSize:${device}`, options);
    return Promise.resolve(
      `Screen size is ${String(this.screenSize.width)}x${String(this.screenSize.height)} pixels`
    );
  }

  public listElements(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`listElements:${device}`, options);
    return Promise.resolve(
      `Found these elements on screen: ${JSON.stringify(this.elements)}`
    );
  }

  public listApps(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`listApps:${device}`, options);
    return Promise.resolve(
      `Found these apps on device: ${this.apps
        .map((app): string => `${app.appName} (${app.packageName})`)
        .join(", ")}`
    );
  }

  public launchApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`launchApp:${device}:${packageName}`, options);
    return Promise.resolve(`Launched app ${packageName}`);
  }

  public terminateApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`terminateApp:${device}:${packageName}`, options);
    return Promise.resolve(`Terminated app ${packageName}`);
  }

  public tap(
    device: string,
    x: number,
    y: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`tap:${device}:${String(x)},${String(y)}`, options);
    return Promise.resolve(
      `Clicked on screen at coordinates: ${String(x)}, ${String(y)}`
    );
  }

  public longPress(
    device: string,
    x: number,
    y: number,
    durationMs: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(
      `longPress:${device}:${String(x)},${String(y)}:${String(durationMs)}`,
      options
    );
    return Promise.resolve(
      [
        "Long pressed on screen at coordinates:",
        `${String(x)}, ${String(y)}`,
        `for ${String(durationMs)}ms`
      ].join(" ")
    );
  }

  public swipe(
    device: string,
    direction: MobileMcpSwipeDirection,
    x?: number,
    y?: number,
    distance?: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(
      `swipe:${device}:${direction}:${String(x)},${String(y)}:${String(distance)}`,
      options
    );
    if (x !== undefined && y !== undefined) {
      const distanceText = distance === undefined
        ? ""
        : ` ${String(distance)} pixels`;
      return Promise.resolve(
        `Swiped ${direction}${distanceText} from coordinates: ${String(x)}, ${String(y)}`
      );
    }
    return Promise.resolve(`Swiped ${direction} on screen`);
  }

  public pressButton(
    device: string,
    button: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`pressButton:${device}:${button}`, options);
    return Promise.resolve(`Pressed the button: ${button}`);
  }

  public typeKeys(
    device: string,
    text: string,
    submit: boolean,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(
      `typeKeys:${device}:${text}:${String(submit)}`,
      options
    );
    return Promise.resolve(`Typed text: ${text}`);
  }

  public saveScreenshot(
    device: string,
    saveTo: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    this.record(`saveScreenshot:${device}:${saveTo}`, options);
    writeFileSync(saveTo, this.screenshotBytes);
    return Promise.resolve(`Screenshot saved to: ${saveTo}`);
  }

  public serverVersion(): string | undefined {
    return this.version;
  }

  public close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    return Promise.resolve();
  }
}
