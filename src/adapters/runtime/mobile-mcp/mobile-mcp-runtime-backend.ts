import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, copyFile, rm, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import type { Point } from "../../../domain/geometry.js";
import type { DisplayViewport } from "../../../domain/geometry.js";
import type {
  DeviceInfo,
  RuntimeBackendDescriptor,
  RuntimeCapabilities
} from "../../../domain/runtime.js";
import type { UiBackendDescriptor } from "../../../domain/ui-backend.js";
import type {
  CommandResult
} from "../../../ports/process-runner.js";
import type {
  OpenRuntimeSessionOptions,
  OpenRuntimeUiSnapshotsOptions,
  RuntimeAppQuery,
  RuntimeBackend,
  RuntimeLaunchOptions,
  RuntimeScreenshotOptions,
  RuntimeSession
} from "../../../ports/runtime-backend.js";
import type {
  CaptureUiSnapshotOptions,
  UiSnapshot,
  UiSnapshotProvider
} from "../../../ports/ui-snapshot.js";
import type {
  UiStabilityObservation,
  UiStabilityProbe,
  UiStabilitySampleOptions
} from "../../../ports/ui-stability.js";
import { snapshotFromCapture } from "../../ui/ui-snapshot-support.js";
import { UiSnapshotError } from "../../ui/ui-snapshot-error.js";
import { MobileMcpToolError } from "./mobile-mcp-errors.js";
import {
  assertMobileMcpToolText,
  mapMobileMcpElement,
  mapMobileMcpSwipe,
  mobileMcpSwipeResponse,
  parseMobileMcpAppPackages,
  parseMobileMcpDevices,
  parseMobileMcpElements,
  parseMobileMcpScreenSize
} from "./mobile-mcp-responses.js";
import type { MobileMcpTools } from "./mobile-mcp-tools.js";

export const MOBILE_MCP_RUNTIME_ADAPTER_VERSION = "mobile-mcp-runtime-v1";
export const MOBILE_MCP_UI_ADAPTER_VERSION = "mobile-mcp-layout-v1";
export const DEFAULT_MOBILE_MCP_SNAPSHOT_TIMEOUT_MS = 10_000;

const SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg"];

export function mobileMcpRuntimeCapabilities(): RuntimeCapabilities {
  return {
    layoutSnapshot: true,
    screenshot: true,
    annotatedScreens: false,
    frameStatsIdle: false,
    logs: false,
    processDiscovery: false,
    windowTopology: false,
    intentStart: false,
    foregroundActivity: false
  };
}

export function mobileMcpUiBackendDescriptor(
  engineVersion: string | undefined
): UiBackendDescriptor {
  const config = { source: "mobile_list_elements_on_screen", version: 1 };
  return {
    id: "mobile-mcp",
    adapterVersion: MOBILE_MCP_UI_ADAPTER_VERSION,
    ...(engineVersion === undefined ? {} : { engineVersion }),
    configSha256: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex")
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function successResult(
  stdout: string,
  durationMs: number
): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs,
    timedOut: false,
    cancelled: false
  };
}

function failureResult(
  stderr: string,
  durationMs: number,
  cancelled: boolean
): CommandResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr,
    durationMs,
    timedOut: false,
    cancelled
  };
}

export class MobileMcpSnapshotProvider implements UiSnapshotProvider {
  private closed = false;

  public constructor(
    private readonly tools: MobileMcpTools,
    private readonly deviceSerial: string,
    public readonly descriptor: UiBackendDescriptor,
    private readonly viewport: DisplayViewport
  ) {}

  public async capture(
    options: CaptureUiSnapshotOptions
  ): Promise<UiSnapshot> {
    if (this.closed) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        "UI snapshot provider is closed"
      );
    }
    const startedAt = performance.now();
    let elements;
    try {
      const text = await this.tools.listElements(this.deviceSerial, {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      elements = parseMobileMcpElements(text);
    } catch (error) {
      if (error instanceof UiSnapshotError) {
        throw error;
      }
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        errorMessage(error),
        { cause: error }
      );
    }
    if (elements.length === 0) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "mobile-mcp returned an empty layout"
      );
    }
    const roots = elements.map(mapMobileMcpElement);
    return snapshotFromCapture({
      startedAt,
      roots,
      backend: this.descriptor,
      viewport: this.viewport,
      timing: {}
    });
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class MobileMcpUiStabilityProbe implements UiStabilityProbe {
  private readonly signatures = new Map<string, string>();

  public constructor(private readonly tools: MobileMcpTools) {}

  public reset(): void {
    this.signatures.clear();
  }

  public async sample(
    options: UiStabilitySampleOptions
  ): Promise<UiStabilityObservation> {
    const startedAt = performance.now();
    const text = await this.tools.listElements(options.deviceSerial, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });
    const layout = parseMobileMcpElements(text).map(mapMobileMcpElement);
    const signature = createHash("sha256")
      .update(JSON.stringify(layout))
      .digest("hex");
    const key = options.deviceSerial;
    const previous = this.signatures.get(key);
    this.signatures.set(key, signature);
    return {
      changes: previous === signature
        ? []
        : [{ layoutSha256: signature }],
      layout,
      backend: "mobileMcp",
      durationMs: performance.now() - startedAt
    };
  }
}

export interface MobileMcpRuntimeSessionDependencies {
  tools: MobileMcpTools;
  deviceSerial: string;
  descriptor: RuntimeBackendDescriptor;
}

export class MobileMcpRuntimeSession implements RuntimeSession {
  public readonly descriptor: RuntimeBackendDescriptor;
  public readonly deviceSerial: string;
  public readonly currentActivity: undefined;
  public readonly deviceIdentity: undefined;
  public readonly foregroundComponent: undefined;
  public readonly appProcesses: undefined;
  public readonly windowTopology: undefined;
  public readonly startLogcat: undefined;
  public readonly dumpLogcat: undefined;
  public readonly annotatedScreens: undefined;
  public readonly startActivityByIntent: undefined;
  public readonly uiStability: UiStabilityProbe;
  private uiSnapshotProvider: Promise<UiSnapshotProvider> | undefined;

  public constructor(
    private readonly dependencies: MobileMcpRuntimeSessionDependencies
  ) {
    this.descriptor = dependencies.descriptor;
    this.deviceSerial = dependencies.deviceSerial;
    this.uiStability = new MobileMcpUiStabilityProbe(dependencies.tools);
  }

  public openUiSnapshots(
    options?: OpenRuntimeUiSnapshotsOptions
  ): Promise<UiSnapshotProvider> {
    if (options?.backend !== undefined && options.backend !== "auto") {
      return Promise.reject(new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        "mobile-mcp",
        `UI backend "${options.backend}" is not available through the mobile-mcp runtime backend`
      ));
    }
    if (this.uiSnapshotProvider !== undefined) {
      return this.uiSnapshotProvider;
    }
    const opened = this.openSnapshotProvider(options);
    opened.catch(() => {
      if (this.uiSnapshotProvider === opened) {
        this.uiSnapshotProvider = undefined;
      }
    });
    this.uiSnapshotProvider = opened;
    return opened;
  }

  private async openSnapshotProvider(
    options?: OpenRuntimeUiSnapshotsOptions
  ): Promise<UiSnapshotProvider> {
    try {
      const text = await this.dependencies.tools.getScreenSize(
        this.deviceSerial,
        {
          timeoutMs: options?.timeoutMs
            ?? DEFAULT_MOBILE_MCP_SNAPSHOT_TIMEOUT_MS,
          ...(options?.signal === undefined ? {} : { signal: options.signal })
        }
      );
      const size = parseMobileMcpScreenSize(text);
      return new MobileMcpSnapshotProvider(
        this.dependencies.tools,
        this.deviceSerial,
        mobileMcpUiBackendDescriptor(
          this.dependencies.tools.serverVersion()
        ),
        {
          width: size.width,
          height: size.height,
          rotation: 0,
          coordinateSpace: "physicalDisplayPixels"
        }
      );
    } catch (error) {
      if (error instanceof UiSnapshotError) {
        throw error;
      }
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        "mobile-mcp",
        errorMessage(error),
        { cause: error }
      );
    }
  }

  public isInstalled(app: RuntimeAppQuery): Promise<boolean> {
    return this.dependencies.tools
      .listApps(this.deviceSerial, {
        ...(app.signal === undefined ? {} : { signal: app.signal }),
        ...(app.timeoutMs === undefined ? {} : { timeoutMs: app.timeoutMs })
      })
      .then((text): boolean => (
        parseMobileMcpAppPackages(text).includes(app.packageName)
      ));
  }

  public launchApp(options: RuntimeLaunchOptions): Promise<CommandResult> {
    return this.runToolAction(options.signal, async () => {
      const text = await this.dependencies.tools.launchApp(
        this.deviceSerial,
        options.packageName,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs })
        }
      );
      assertMobileMcpToolText(
        "mobile_launch_app",
        text,
        `Launched app ${options.packageName}`
      );
      return text;
    });
  }

  public forceStop(app: RuntimeAppQuery): Promise<CommandResult> {
    return this.runToolAction(app.signal, async () => {
      const text = await this.dependencies.tools.terminateApp(
        this.deviceSerial,
        app.packageName,
        {
          ...(app.signal === undefined ? {} : { signal: app.signal }),
          ...(app.timeoutMs === undefined ? {} : { timeoutMs: app.timeoutMs })
        }
      );
      assertMobileMcpToolText(
        "mobile_terminate_app",
        text,
        `Terminated app ${app.packageName}`
      );
      return text;
    });
  }

  public tap(point: Point, signal?: AbortSignal): Promise<CommandResult> {
    return this.runToolAction(signal, async () => {
      const text = await this.dependencies.tools.tap(
        this.deviceSerial,
        point.x,
        point.y,
        signal === undefined ? undefined : { signal }
      );
      assertMobileMcpToolText(
        "mobile_click_on_screen_at_coordinates",
        text,
        `Clicked on screen at coordinates: ${String(point.x)}, ${String(point.y)}`
      );
      return text;
    });
  }

  public longClick(
    point: Point,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.runToolAction(signal, async () => {
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10_000) {
        throw new MobileMcpToolError(
          "mobile_long_press_on_screen_at_coordinates",
          `long press duration must be an integer between 1 and 10000 ms, received ${String(durationMs)}`
        );
      }
      const text = await this.dependencies.tools.longPress(
        this.deviceSerial,
        point.x,
        point.y,
        durationMs,
        signal === undefined ? undefined : { signal }
      );
      assertMobileMcpToolText(
        "mobile_long_press_on_screen_at_coordinates",
        text,
        [
          "Long pressed on screen at coordinates:",
          `${String(point.x)}, ${String(point.y)}`,
          `for ${String(durationMs)}ms`
        ].join(" ")
      );
      return text;
    });
  }

  public swipe(
    from: Point,
    to: Point,
    _durationMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return this.runToolAction(signal, async () => {
      const mapping = mapMobileMcpSwipe(from, to);
      const text = await this.dependencies.tools.swipe(
        this.deviceSerial,
        mapping.direction,
        mapping.x,
        mapping.y,
        mapping.distance,
        signal === undefined ? undefined : { signal }
      );
      assertMobileMcpToolText(
        "mobile_swipe_on_screen",
        text,
        mobileMcpSwipeResponse(mapping)
      );
      return text;
    });
  }

  public back(signal?: AbortSignal): Promise<CommandResult> {
    return this.runToolAction(signal, async () => {
      const text = await this.dependencies.tools.pressButton(
        this.deviceSerial,
        "BACK",
        signal === undefined ? undefined : { signal }
      );
      assertMobileMcpToolText(
        "mobile_press_button",
        text,
        "Pressed the button: BACK"
      );
      return text;
    });
  }

  public inputText(text: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.runToolAction(signal, async () => {
      const response = await this.dependencies.tools.typeKeys(
        this.deviceSerial,
        text,
        false,
        signal === undefined ? undefined : { signal }
      );
      assertMobileMcpToolText(
        "mobile_type_keys",
        response,
        `Typed text: ${text}`
      );
      return response;
    });
  }

  public captureScreenshot(
    options: RuntimeScreenshotOptions
  ): Promise<CommandResult> {
    if (options.annotate === true) {
      return Promise.resolve(failureResult(
        "the mobile-mcp runtime backend cannot annotate screenshots",
        0,
        false
      ));
    }
    const extension = extname(options.outputPath).toLowerCase();
    if (!SCREENSHOT_EXTENSIONS.includes(extension)) {
      return Promise.resolve(failureResult(
        `screenshot output must end with ${SCREENSHOT_EXTENSIONS.join(", ")}, received "${options.outputPath}"`,
        0,
        false
      ));
    }
    return this.runToolAction(options.signal, async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "taphound-mobile-mcp-"));
      let tempPath: string | undefined;
      try {
        tempPath = join(tempDir, `screenshot${extension}`);
        const text = await this.dependencies.tools.saveScreenshot(
          this.deviceSerial,
          tempPath,
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs })
          }
        );
        assertMobileMcpToolText(
          "mobile_save_screenshot",
          text,
          `Screenshot saved to: ${tempPath}`
        );
        await mkdir(dirname(options.outputPath), { recursive: true });
        try {
          await rename(tempPath, options.outputPath);
        } catch {
          await copyFile(tempPath, options.outputPath);
          await unlink(tempPath).catch(() => {});
        }
        return `Screenshot saved to: ${options.outputPath}`;
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  private async runToolAction(
    signal: AbortSignal | undefined,
    invoke: () => Promise<string>
  ): Promise<CommandResult> {
    const startedAt = performance.now();
    try {
      const stdout = await invoke();
      return successResult(stdout, performance.now() - startedAt);
    } catch (error) {
      return failureResult(
        errorMessage(error),
        performance.now() - startedAt,
        signal?.aborted === true
      );
    }
  }

  public async close(): Promise<void> {
    const provider = this.uiSnapshotProvider;
    this.uiSnapshotProvider = undefined;
    if (provider !== undefined) {
      await provider.then(
        (snapshotProvider): Promise<void> => snapshotProvider.close(),
        () => undefined
      );
    }
    await this.dependencies.tools.close();
  }
}

export interface MobileMcpRuntimeBackendDependencies {
  createTools: () => MobileMcpTools;
  engineVersion?: string | undefined;
}

export class MobileMcpRuntimeBackend implements RuntimeBackend {
  public readonly descriptor: RuntimeBackendDescriptor;
  public readonly capabilities: RuntimeCapabilities;

  public constructor(
    private readonly dependencies: MobileMcpRuntimeBackendDependencies
  ) {
    const capabilities = mobileMcpRuntimeCapabilities();
    this.capabilities = capabilities;
    this.descriptor = {
      id: "mobile-mcp",
      adapterVersion: MOBILE_MCP_RUNTIME_ADAPTER_VERSION,
      ...(dependencies.engineVersion === undefined
        ? {}
        : { engineVersion: dependencies.engineVersion }),
      configSha256: createHash("sha256").update(JSON.stringify({
        id: "mobile-mcp",
        adapterVersion: MOBILE_MCP_RUNTIME_ADAPTER_VERSION,
        ...(dependencies.engineVersion === undefined
          ? {}
          : { engineVersion: dependencies.engineVersion }),
        capabilities
      })).digest("hex"),
      capabilities
    };
  }

  public async listDevices(
    signal?: AbortSignal
  ): Promise<readonly DeviceInfo[]> {
    const tools = this.dependencies.createTools();
    try {
      const text = await tools.listDevices(
        signal === undefined ? undefined : { signal }
      );
      return parseMobileMcpDevices(text)
        .filter((device): boolean => (
          device.platform === "android" && device.state === "online"
        ))
        .map((device): DeviceInfo => ({
          serial: device.id,
          status: "device"
        }));
    } finally {
      await tools.close();
    }
  }

  public openSession(
    options: OpenRuntimeSessionOptions
  ): Promise<RuntimeSession> {
    return Promise.resolve(new MobileMcpRuntimeSession({
      tools: this.dependencies.createTools(),
      deviceSerial: options.deviceSerial,
      descriptor: this.descriptor
    }));
  }
}
