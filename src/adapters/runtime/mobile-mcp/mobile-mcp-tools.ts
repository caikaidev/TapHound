export type MobileMcpSwipeDirection = "up" | "down" | "left" | "right";

export interface MobileMcpDeviceEntry {
  id: string;
  name?: string | undefined;
  platform: string;
  type?: string | undefined;
  version?: string | undefined;
  state?: string | undefined;
  model?: string | undefined;
}

export interface MobileMcpElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MobileMcpElement {
  type?: string | undefined;
  text?: string | undefined;
  label?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  identifier?: string | undefined;
  coordinates: MobileMcpElementRect;
  focused?: boolean | undefined;
}

export interface MobileMcpToolCallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface MobileMcpTools {
  listDevices(options?: MobileMcpToolCallOptions): Promise<string>;
  getScreenSize(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  listElements(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  listApps(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  launchApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  terminateApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  tap(
    device: string,
    x: number,
    y: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  longPress(
    device: string,
    x: number,
    y: number,
    durationMs: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  swipe(
    device: string,
    direction: MobileMcpSwipeDirection,
    x?: number,
    y?: number,
    distance?: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  pressButton(
    device: string,
    button: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  typeKeys(
    device: string,
    text: string,
    submit: boolean,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  saveScreenshot(
    device: string,
    saveTo: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string>;
  serverVersion(): string | undefined;
  close(): Promise<void>;
}
