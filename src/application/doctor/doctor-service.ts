import type { FailureCode } from "../../domain/failure.js";
import type { AdbPort } from "../../ports/adb.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

export type DoctorCheckName =
  | "node"
  | "adb"
  | "android"
  | "app"
  | "permissions"
  | "device";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: "passed" | "failed" | "notRun";
  version?: string | undefined;
  message?: string | undefined;
}

export interface DoctorReport {
  status: "passed" | "failed";
  checks: DoctorCheck[];
  deviceSerial?: string | undefined;
  failureCode?: Extract<
    FailureCode,
    "ENVIRONMENT_MISSING_TOOL" | "DEVICE_UNAVAILABLE" | "APP_NOT_INSTALLED"
  > | undefined;
}

export interface DoctorRunInput {
  packageName?: string | undefined;
  requestedDevice?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface DoctorDependencies {
  runner: ProcessRunner;
  adb: AdbPort;
  nodeVersion: string;
  checkAndroidPermissions: (
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<{
    status: "passed" | "failed";
    message?: string | undefined;
  }>;
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
        message: "TapHound requires Node.js 22 or newer"
      };
}

export class DoctorService {
  public constructor(private readonly dependencies: DoctorDependencies) {}

  public async run(input: DoctorRunInput = {}): Promise<DoctorReport> {
    const { packageName, requestedDevice, signal } = input;
    const checks: DoctorCheck[] = [nodeCheck(this.dependencies.nodeVersion)];
    const tool = async (
      name: Extract<DoctorCheckName, "adb" | "android">,
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
    let deviceSerial: string | undefined;
    let deviceCheck: DoctorCheck;
    try {
      const devices = (await this.dependencies.adb.devices(signal)).filter(
        (device) => device.status === "device"
      );
      const selected = requestedDevice === undefined
        ? (devices.length === 1 ? devices[0] : undefined)
        : devices.find((device) => device.serial === requestedDevice);
      if (selected !== undefined) {
        deviceSerial = selected.serial;
        deviceCheck = {
          name: "device",
          status: "passed",
          message: deviceSerial
        };
      } else {
        deviceCheck = {
          name: "device",
          status: "failed",
          message: requestedDevice === undefined
            ? `Expected exactly one online device, found ${String(devices.length)}`
            : `Requested device is not online: ${requestedDevice}`
        };
      }
    } catch (error) {
      deviceCheck = {
        name: "device",
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (packageName === undefined) {
      checks.push({
        name: "app",
        status: "notRun",
        message: "Installed application probe requires a configured package"
      });
    } else if (deviceSerial === undefined) {
      checks.push({
        name: "app",
        status: "notRun",
        message: "Installed application probe requires an online selected device"
      });
    } else {
      try {
        const installed = await this.dependencies.adb.isInstalled({
          packageName,
          deviceSerial,
          ...(signal === undefined ? {} : { signal })
        });
        checks.push(installed
          ? { name: "app", status: "passed", message: packageName }
          : {
              name: "app",
              status: "failed",
              message: `Package ${packageName} is not installed on ${deviceSerial}`
            });
      } catch (error) {
        checks.push({
          name: "app",
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (deviceSerial === undefined) {
      checks.push({
        name: "permissions",
        status: "notRun",
        message: "Permission probe requires an online selected device"
      });
    } else {
      try {
        const permission = await this.dependencies.checkAndroidPermissions(
          deviceSerial,
          signal
        );
        checks.push({
          name: "permissions",
          status: permission.status,
          ...(permission.message === undefined
            ? {}
            : { message: permission.message })
        });
      } catch (error) {
        checks.push({
          name: "permissions",
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    checks.push(deviceCheck);

    const failedCheck = (name: DoctorCheckName): boolean => checks.some(
      (check) => check.name === name && check.status === "failed"
    );
    const environmentFailed = (["node", "adb", "android", "permissions"] as const)
      .some(failedCheck);
    const failureCode = environmentFailed
      ? "ENVIRONMENT_MISSING_TOOL"
      : failedCheck("device")
        ? "DEVICE_UNAVAILABLE"
        : failedCheck("app")
          ? "APP_NOT_INSTALLED"
          : undefined;
    if (failureCode !== undefined) {
      return {
        status: "failed",
        checks,
        ...(deviceSerial === undefined ? {} : { deviceSerial }),
        failureCode
      };
    }
    return {
      status: "passed",
      checks,
      ...(deviceSerial === undefined ? {} : { deviceSerial })
    };
  }
}
