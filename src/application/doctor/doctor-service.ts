import type { FailureCode } from "../../domain/failure.js";
import type { AdbPort } from "../../ports/adb.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

export type DoctorCheckName =
  | "node"
  | "adb"
  | "android"
  | "gradle"
  | "permissions"
  | "device";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: "passed" | "failed";
  version?: string | undefined;
  message?: string | undefined;
}

export interface DoctorReport {
  status: "passed" | "failed";
  checks: DoctorCheck[];
  deviceSerial?: string | undefined;
  failureCode?: Extract<
    FailureCode,
    "ENVIRONMENT_MISSING_TOOL" | "DEVICE_UNAVAILABLE"
  > | undefined;
}

export interface DoctorDependencies {
  runner: ProcessRunner;
  adb: AdbPort;
  nodeVersion: string;
  checkGradleWrapper: (projectRoot: string) => Promise<boolean>;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "unknown";
}

function nodeCheck(version: string): DoctorCheck {
  const normalized = version.replace(/^v/, "");
  const major = Number(normalized.split(".", 1)[0]);
  return Number.isInteger(major) && major >= 22
    ? { name: "node", status: "passed", version: normalized }
    : {
        name: "node",
        status: "failed",
        version: normalized,
        message: "APR requires Node.js 22 or newer"
      };
}

export class DoctorService {
  public constructor(private readonly dependencies: DoctorDependencies) {}

  public async run(
    projectRoot: string,
    signal?: AbortSignal,
    requestedDevice?: string
  ): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [nodeCheck(this.dependencies.nodeVersion)];
    const tool = async (
      name: Extract<DoctorCheckName, "adb" | "android" | "permissions">,
      executable: string,
      args: readonly string[]
    ): Promise<DoctorCheck> => {
      try {
        const result = await this.dependencies.runner.run({
          executable,
          args,
          ...(signal === undefined ? {} : { signal })
        });
        if (
          result.exitCode !== 0
          || result.spawnError !== undefined
          || result.cancelled
          || result.timedOut
        ) {
          return {
            name,
            status: "failed",
            message: result.stderr.trim()
              || result.spawnError
              || `${executable} check failed`
          };
        }
        return {
          name,
          status: "passed",
          version: firstLine(result.stdout)
        };
      } catch (error) {
        return {
          name,
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    };

    checks.push(
      await tool("adb", "adb", ["version"]),
      await tool("android", "android", ["--version"])
    );
    try {
      const available = await this.dependencies.checkGradleWrapper(projectRoot);
      checks.push(available
        ? { name: "gradle", status: "passed" }
        : {
            name: "gradle",
            status: "failed",
            message: "Executable Gradle wrapper was not found"
          });
    } catch (error) {
      checks.push({
        name: "gradle",
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    checks.push(await tool(
      "permissions",
      "android",
      ["doctor", "--json"]
    ));

    let deviceSerial: string | undefined;
    try {
      const devices = (await this.dependencies.adb.devices(signal)).filter(
        (device) => device.status === "device"
      );
      const selected = requestedDevice === undefined
        ? (devices.length === 1 ? devices[0] : undefined)
        : devices.find((device) => device.serial === requestedDevice);
      if (selected !== undefined) {
        deviceSerial = selected.serial;
        checks.push({
          name: "device",
          status: "passed",
          message: deviceSerial
        });
      } else {
        checks.push({
          name: "device",
          status: "failed",
          message: requestedDevice === undefined
            ? `Expected exactly one online device, found ${String(devices.length)}`
            : `Requested device is not online: ${requestedDevice}`
        });
      }
    } catch (error) {
      checks.push({
        name: "device",
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const environmentFailed = checks.some(
      (check) => check.name !== "device" && check.status === "failed"
    );
    const deviceFailed = checks.some(
      (check) => check.name === "device" && check.status === "failed"
    );
    if (environmentFailed || deviceFailed) {
      return {
        status: "failed",
        checks,
        ...(deviceSerial === undefined ? {} : { deviceSerial }),
        failureCode: environmentFailed
          ? "ENVIRONMENT_MISSING_TOOL"
          : "DEVICE_UNAVAILABLE"
      };
    }
    return {
      status: "passed",
      checks,
      ...(deviceSerial === undefined ? {} : { deviceSerial })
    };
  }
}
