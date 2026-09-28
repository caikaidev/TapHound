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

export class AppiumHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Appium HTTP ${String(status)}`);
    this.name = "AppiumHttpError";
  }
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
      throw new AppiumHttpError(response.status);
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A page source request that timed out or hit a session Appium no longer
 * knows (HTTP 404) points at a degraded UiAutomator2 session, not at the app.
 */
function degradedSession(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "TimeoutError")
    || (error instanceof AppiumHttpError && error.status === 404);
}

type CreateAppiumSession = (signal?: AbortSignal) => Promise<string>;

class AppiumUiSnapshotProvider implements UiSnapshotProvider, UiStabilityProbe {
  private closePromise: Promise<void> | undefined;
  private lastSourceSignature: string | undefined;

  public constructor(
    private readonly http: AppiumHttpClient,
    private sessionId: string,
    private readonly createSession: CreateAppiumSession,
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
      source = await this.pageSource(options);
    } catch (error) {
      if (options.signal?.aborted === true || !degradedSession(error)) {
        throw this.captureFailure(errorText(error), error);
      }
      // Capture is read-only, so one retry on a fresh session cannot change
      // what Replay observes; it only stops a degraded session from turning
      // into a false verification failure.
      try {
        await this.recreateSession(options.signal);
        source = await this.pageSource(options);
      } catch (retryError) {
        throw this.captureFailure(
          `${errorText(error)}; retry on a recreated session failed: ${
            errorText(retryError)
          }`,
          retryError
        );
      }
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

  private async pageSource(options: CaptureUiSnapshotOptions): Promise<unknown> {
    return (await this.http.request({
      method: "GET",
      path: `/session/${this.sessionId}/source`,
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })).value;
  }

  private captureFailure(detail: string, cause: unknown): UiSnapshotError {
    return new UiSnapshotError(
      "UI_SNAPSHOT_FAILED",
      this.descriptor.id,
      `Appium page source capture failed: ${detail}`,
      { cause, terminal: true }
    );
  }

  private async recreateSession(signal?: AbortSignal): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/session/${this.sessionId}`,
      timeoutMs: 2000
    }).catch(() => undefined);
    const sessionId = await this.createSession(signal);
    if (this.closePromise !== undefined) {
      await this.http.request({
        method: "DELETE",
        path: `/session/${sessionId}`,
        timeoutMs: 5000
      }).catch(() => undefined);
      throw new Error("Appium UI snapshot provider is closed");
    }
    this.sessionId = sessionId;
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
    let provider: AppiumUiSnapshotProvider | undefined;
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
      const createSession: CreateAppiumSession = (signal) => this.createSession(
        options.deviceSerial,
        options.timeoutMs,
        signal
      );
      const sessionId = await createSession(options.signal);
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
      provider = new AppiumUiSnapshotProvider(
        this.http,
        sessionId,
        createSession,
        environment,
        descriptor
      );
      await provider.capture({
        reason: "evidence",
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      return provider;
    } catch (error) {
      await provider?.close().catch(() => undefined);
      if (error instanceof UiSnapshotError) throw error;
      throw new UiSnapshotError(
        "UI_BACKEND_UNAVAILABLE",
        "appium-uiautomator2",
        "Appium UiAutomator2 session could not be opened",
        { cause: error }
      );
    }
  }

  private async createSession(
    deviceSerial: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<string> {
    const created = objectValue((await this.http.request({
      method: "POST",
      path: "/session",
      timeoutMs,
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:udid": deviceSerial,
            "appium:noReset": true,
            "appium:autoLaunch": false,
            "appium:autoGrantPermissions": false,
            "appium:fullReset": false,
            "appium:shouldTerminateApp": false
          },
          firstMatch: [{}]
        }
      },
      ...(signal === undefined ? {} : { signal })
    })).value);
    const sessionId = typeof created.sessionId === "string"
      ? created.sessionId
      : undefined;
    if (sessionId === undefined) {
      throw new Error("Appium did not return a session id");
    }
    try {
      await this.http.request({
        method: "POST",
        path: `/session/${sessionId}/appium/settings`,
        timeoutMs,
        body: { settings: this.settings },
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      await this.http.request({
        method: "DELETE",
        path: `/session/${sessionId}`,
        timeoutMs: 5000
      }).catch(() => undefined);
      throw error;
    }
    return sessionId;
  }
}
