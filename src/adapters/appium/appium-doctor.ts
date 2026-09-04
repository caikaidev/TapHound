import type {
  CommandResult,
  ProcessRunner
} from "../../ports/process-runner.js";

export interface AppiumDoctorResult {
  status: "passed" | "failed";
  version?: string | undefined;
  message?: string | undefined;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "unknown";
}

function driverVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const serialized = JSON.stringify(value);
  const match = serialized.match(/uiautomator2[^\d]*([\d]+(?:\.[\d]+)+(?:[-+][\w.-]+)?)/i);
  return match?.[1];
}

export async function checkAppiumUiAutomator2(
  runner: ProcessRunner,
  signal?: AbortSignal
): Promise<AppiumDoctorResult> {
  const command = async (args: readonly string[]): Promise<CommandResult> => runner.run({
    executable: "appium",
    args,
    timeoutMs: 5000,
    ...(signal === undefined ? {} : { signal })
  });
  try {
    const version = await command(["--version"]);
    if (
      version.exitCode !== 0
      || version.spawnError !== undefined
      || version.timedOut
      || version.cancelled
    ) {
      return {
        status: "failed",
        message: version.stderr.trim() || version.spawnError || "Appium server is unavailable"
      };
    }
    const drivers = await command(["driver", "list", "--installed", "--json"]);
    if (
      drivers.exitCode !== 0
      || drivers.spawnError !== undefined
      || drivers.timedOut
      || drivers.cancelled
    ) {
      return {
        status: "failed",
        version: firstLine(version.stdout),
        message: drivers.stderr.trim() || drivers.spawnError
          || "Appium UiAutomator2 driver check failed"
      };
    }
    let installed: unknown;
    try {
      installed = JSON.parse(drivers.stdout) as unknown;
    } catch {
      return {
        status: "failed",
        version: firstLine(version.stdout),
        message: "Appium driver list returned invalid JSON"
      };
    }
    const driver = driverVersion(installed);
    if (driver === undefined || !/uiautomator2/i.test(JSON.stringify(installed))) {
      return {
        status: "failed",
        version: firstLine(version.stdout),
        message: "Appium UiAutomator2 driver is not installed"
      };
    }
    let serverVersion: string | undefined;
    try {
      const response = await fetch("http://127.0.0.1:4723/status", {
        signal: AbortSignal.timeout(5000)
      });
      const payload = await response.json() as {
        value?: { build?: { version?: unknown } };
      };
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      serverVersion = typeof payload.value?.build?.version === "string"
        ? payload.value.build.version
        : undefined;
    } catch (error) {
      return {
        status: "failed",
        version: firstLine(version.stdout),
        message: `UiAutomator2 ${driver}; start: appium --address 127.0.0.1 --port 4723 (${error instanceof Error ? error.message : String(error)})`
      };
    }
    return {
      status: "passed",
      version: firstLine(version.stdout),
      message: `UiAutomator2 ${driver}; server ${serverVersion ?? "unknown"}; start: appium --address 127.0.0.1 --port 4723`
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
