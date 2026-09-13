import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { parseAppiumPageSource } from "../adb/ui-automator-parser.js";
import type { UiBackendDescriptor } from "../../domain/ui-backend.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import type {
  CaptureUiSnapshotOptions,
  OpenUiSnapshotProviderOptions,
  UiSnapshot,
  UiSnapshotProvider,
  UiSnapshotProviderFactory
} from "../../ports/ui-snapshot.js";
import type {
  UiStabilityProbe,
  UiStabilitySampleOptions,
  UiStabilitySampleResult
} from "../../ports/ui-stability.js";
import {
  readDeviceUiEnvironment,
  type DeviceUiEnvironment
} from "../ui/device-ui-environment.js";
import { UiSnapshotError } from "../ui/ui-snapshot-error.js";
import { snapshotFromCapture } from "../ui/ui-snapshot-support.js";

export interface AppiumHttpRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface AppiumHttpClient {
  request(input: AppiumHttpRequest): Promise<{ value: unknown }>;
}

export interface AppiumProviderOptions {
  endpoint?: string | undefined;
  mapTestTagToResourceId?: boolean | undefined;
}

function loopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username !== ""
    || endpoint.password !== ""
  ) {
    throw new Error("Appium endpoint must be an unauthenticated loopback HTTP URL");
  }
  return endpoint;
}

export class FetchAppiumHttpClient implements AppiumHttpClient {
  public constructor(private readonly endpoint: URL) {}

  public async request(input: AppiumHttpRequest): Promise<{ value: unknown }> {
    const timeout = AbortSignal.timeout(Math.trunc(input.timeoutMs));
    const signal = input.signal === undefined
      ? timeout
      : AbortSignal.any([input.signal, timeout]);
    const response = await fetch(new URL(input.path.slice(1), this.endpoint), {
      method: input.method,
      ...(input.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input.body)
          }),
      signal
    });
    const payload = await response.json() as { value?: unknown };
    if (!response.ok) {
      throw new Error(`Appium HTTP ${String(response.status)}`);
    }
    return { value: payload.value };
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Appium returned an invalid response");
  }
  return value as Record<string, unknown>;
}

class AppiumUiSnapshotProvider implements UiSnapshotProvider, UiStabilityProbe {
  private closePromise: Promise<void> | undefined;
  private lastSourceSignature: string | undefined;

  public constructor(
    private readonly http: AppiumHttpClient,
    private readonly sessionId: string,
    private readonly environment: DeviceUiEnvironment,
    public readonly descriptor: UiBackendDescriptor
  ) {}

  public reset(): void {
    this.lastSourceSignature = undefined;
  }

  public async sample(
    options: UiStabilitySampleOptions
  ): Promise<UiStabilitySampleResult> {
    void options.deviceSerial;
    const startedAt = performance.now();
    const snapshot = await this.capture({
      reason: "idle",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? 5000
    });
    const signature = createHash("sha256")
      .update(JSON.stringify(snapshot.roots))
      .digest("hex");
    const previous = this.lastSourceSignature;
    this.lastSourceSignature = signature;
    return {
      changes: previous === signature ? [] : [{ layoutSha256: signature }],
      layout: snapshot.roots,
      backend: "uiautomator",
      durationMs: performance.now() - startedAt
    };
  }

  public async capture(options: CaptureUiSnapshotOptions): Promise<UiSnapshot> {
    if (this.closePromise !== undefined) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        "Appium UI snapshot provider is closed"
      );
    }
    const startedAt = performance.now();
    let source: unknown;
    try {
      source = (await this.http.request({
        method: "GET",
        path: `/session/${this.sessionId}/source`,
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })).value;
    } catch (error) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_FAILED",
        this.descriptor.id,
        `Appium page source capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error, terminal: true }
      );
    }
    if (typeof source !== "string") {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "Appium returned a non-string page source"
      );
    }
    let roots;
    try {
      roots = parseAppiumPageSource(source);
    } catch (error) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "Appium returned malformed page source",
        { cause: error }
      );
    }
    if (roots.length === 0) {
      throw new UiSnapshotError(
        "UI_SNAPSHOT_INVALID",
        this.descriptor.id,
        "Appium returned an empty layout"
      );
    }
    return snapshotFromCapture({
      startedAt,
      roots,
      backend: this.descriptor,
      viewport: this.environment.viewport,
      timing: {}
    });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.http.request({
      method: "DELETE",
      path: `/session/${this.sessionId}`,
      timeoutMs: 5000
    }).then(() => undefined);
    return this.closePromise;
  }
}

export class AppiumUiSnapshotProviderFactory implements
  UiSnapshotProviderFactory {
  private readonly endpoint: URL;
  private readonly http: AppiumHttpClient;
  private readonly settings: { mapTestTagToResourceId: boolean };

  public constructor(
    private readonly runner: ProcessRunner,
    http?: AppiumHttpClient,
    options: AppiumProviderOptions = {}
  ) {
    this.endpoint = loopbackEndpoint(
      options.endpoint ?? "http://127.0.0.1:4723/"
    );
    this.http = http ?? new FetchAppiumHttpClient(this.endpoint);
    this.settings = {
      mapTestTagToResourceId: options.mapTestTagToResourceId ?? false
    };
  }

  public async probe(timeoutMs = 2000): Promise<boolean> {
    try {
      const response = await this.http.request({
        method: "GET",
        path: "/status",
        timeoutMs
      });
      return response.value !== undefined;
    } catch {
      return false;
    }
  }

  public async open(
    options: OpenUiSnapshotProviderOptions
  ): Promise<UiSnapshotProvider> {
    const environment = await readDeviceUiEnvironment(
      this.runner,
      "appium-uiautomator2",
      options
    );
    let provisionalSessionId: string | undefined;
    try {
      const status = objectValue((await this.http.request({
        method: "GET",
        path: "/status",
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })).value);
      const build = status.build === undefined ? {} : objectValue(status.build);
      const engineVersion = typeof build.version === "string"
        ? build.version
        : "unknown";
      const created = objectValue((await this.http.request({
        method: "POST",
        path: "/session",
        timeoutMs: options.timeoutMs,
        body: {
          capabilities: {
            alwaysMatch: {
              platformName: "Android",
              "appium:automationName": "UiAutomator2",
              "appium:udid": options.deviceSerial,
              "appium:noReset": true,
              "appium:autoLaunch": false,
              "appium:autoGrantPermissions": false,
              "appium:fullReset": false,
              "appium:shouldTerminateApp": false
            },
            firstMatch: [{}]
          }
        },
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })).value);
      const sessionId = typeof created.sessionId === "string"
        ? created.sessionId
        : undefined;
      if (sessionId === undefined) {
        throw new Error("Appium did not return a session id");
      }
      provisionalSessionId = sessionId;
      await this.http.request({
        method: "POST",
        path: `/session/${sessionId}/appium/settings`,
        timeoutMs: options.timeoutMs,
        body: { settings: this.settings },
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      const descriptor: UiBackendDescriptor = {
        id: "appium-uiautomator2",
        adapterVersion: "appium-uiautomator2-v1",
        engineVersion,
        configSha256: createHash("sha256").update(JSON.stringify({
          endpoint: this.endpoint.origin,
          settings: this.settings,
          capabilitiesVersion: 1
        })).digest("hex")
      };
      const provider = new AppiumUiSnapshotProvider(
        this.http,
        sessionId,
        environment,
        descriptor
      );
      await provider.capture({
        reason: "evidence",
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      provisionalSessionId = undefined;
      return provider;
    } catch (error) {
      if (provisionalSessionId !== undefined) {
        await this.http.request({
          method: "DELETE",
          path: `/session/${provisionalSessionId}`,
          timeoutMs: 5000
        }).catch(() => undefined);
      }
      if (error instanceof UiSnapshotError) throw error;
      throw new UiSnapshotError(
        "UI_BACKEND_UNAVAILABLE",
        "appium-uiautomator2",
        "Appium UiAutomator2 session could not be opened",
        { cause: error }
      );
    }
  }
}
