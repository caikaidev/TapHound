import type { FailureCode } from "../../domain/failure.js";
import type { RuntimeBackendId } from "../../domain/runtime.js";
import type { UiBackendSelection } from "../../domain/ui-backend.js";
import type { AdbPort } from "../../ports/adb.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import type { DeviceAssignment } from "../devices/resolve-device-assignments.js";

export type DoctorCheckName =
  | "node"
  | "adb"
  | "android"
  | "app"
  | "permissions"
  | "device"
  | "appium"
  | "mobile-mcp";

export type DoctorCheckStatus = "passed" | "failed" | "notRun";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  version?: string | undefined;
  message?: string | undefined;
}

export interface DoctorDeviceCheck {
  role: string;
  deviceSerial: string;
  online: boolean;
  app: DoctorCheckStatus;
  permissions: DoctorCheckStatus;
  message?: string | undefined;
}

export interface DoctorReport {
  status: "passed" | "failed";
  runtimeBackend: RuntimeBackendId;
  checks: DoctorCheck[];
  deviceSerial?: string | undefined;
  devices?: readonly DoctorDeviceCheck[] | undefined;
  failureCode?: Extract<
    FailureCode,
    "ENVIRONMENT_MISSING_TOOL" | "DEVICE_UNAVAILABLE" | "APP_NOT_INSTALLED"
  > | undefined;
}

export interface DoctorRunInput {
  packageName?: string | undefined;
  requestedDevice?: string | undefined;
  requestedDevices?: readonly DeviceAssignment[] | undefined;
  signal?: AbortSignal | undefined;
  skipPermissionProbe?: boolean | undefined;
  requestedUiBackend?: UiBackendSelection | undefined;
}

export interface DoctorDependencies {
  runner: ProcessRunner;
  adb: AdbPort;
  nodeVersion: string;
  runtimeBackendId: RuntimeBackendId;
  checkAndroidPermissions: (
    deviceSerial: string,
    signal?: AbortSignal
  ) => Promise<{
    status: "passed" | "failed";
    message?: string | undefined;
  }>;
  checkAppiumUiAutomator2?: (
    signal?: AbortSignal
  ) => Promise<{
    status: "passed" | "failed";
    version?: string | undefined;
    message?: string | undefined;
  }>;
  checkMobileMcpServer?: (
    signal?: AbortSignal
  ) => Promise<{
    status: "passed" | "failed";
    version?: string | undefined;
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
    const assignments = input.requestedDevices;
    if (assignments !== undefined && assignments.length > 0) {
      return this.runForAssignments(input, assignments);
    }
    return this.runSingleDevice(input);
  }

  private async environmentChecks(input: DoctorRunInput): Promise<DoctorCheck[]> {
    const { signal } = input;
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

    checks.push(await tool("adb", "adb", ["version"]));
    if (this.dependencies.runtimeBackendId === "mobile-mcp") {
      checks.push({
        name: "android",
        status: "notRun",
        message: "Android CLI probe requires the adb runtime backend"
      });
      try {
        const mobileMcp = await this.dependencies.checkMobileMcpServer?.(signal);
        checks.push(mobileMcp === undefined ? {
          name: "mobile-mcp",
          status: "failed",
          message: "Mobile MCP server check is not configured"
        } : {
          name: "mobile-mcp",
          status: mobileMcp.status,
          ...(mobileMcp.version === undefined ? {} : { version: mobileMcp.version }),
          ...(mobileMcp.message === undefined ? {} : { message: mobileMcp.message })
        });
      } catch (error) {
        checks.push({
          name: "mobile-mcp",
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      checks.push(await tool("android", "android", ["--version"]));
      checks.push({
        name: "mobile-mcp",
        status: "notRun",
        message: "Mobile MCP server probe requires the mobile-mcp runtime backend"
      });
    }
    if (input.requestedUiBackend === "appium-uiautomator2") {
      if (this.dependencies.runtimeBackendId === "mobile-mcp") {
        checks.push({
          name: "appium",
          status: "failed",
          message: "ui.backend=appium-uiautomator2 is not supported by the mobile-mcp runtime backend"
        });
      } else {
        try {
          const appium = await this.dependencies.checkAppiumUiAutomator2?.(signal);
          checks.push(appium === undefined ? {
            name: "appium",
            status: "failed",
            message: "Appium UiAutomator2 check is not configured"
          } : {
            name: "appium",
            status: appium.status,
            ...(appium.version === undefined ? {} : { version: appium.version }),
            ...(appium.message === undefined ? {} : { message: appium.message })
          });
        } catch (error) {
          checks.push({
            name: "appium",
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } else {
      checks.push({
        name: "appium",
        status: "notRun",
        message: "Appium probe requires ui.backend=appium-uiautomator2"
      });
    }
    return checks;
  }

  private conclude(
    checks: DoctorCheck[],
    identity: {
      deviceSerial?: string;
      devices?: readonly DoctorDeviceCheck[];
    }
  ): DoctorReport {
    const failedCheck = (name: DoctorCheckName): boolean => checks.some(
      (check) => check.name === name && check.status === "failed"
    );
    const environmentFailed = (
      ["node", "adb", "android", "appium", "mobile-mcp", "permissions"] as const
    ).some(failedCheck);
    const failureCode = environmentFailed
      ? "ENVIRONMENT_MISSING_TOOL"
      : failedCheck("device")
        ? "DEVICE_UNAVAILABLE"
        : failedCheck("app")
          ? "APP_NOT_INSTALLED"
          : undefined;
    return {
      status: failureCode === undefined ? "passed" : "failed",
      runtimeBackend: this.dependencies.runtimeBackendId,
      checks,
      ...(identity.deviceSerial === undefined
        ? {}
        : { deviceSerial: identity.deviceSerial }),
      ...(identity.devices === undefined ? {} : { devices: identity.devices }),
      ...(failureCode === undefined ? {} : { failureCode })
    };
  }

  private async runSingleDevice(input: DoctorRunInput): Promise<DoctorReport> {
    const { packageName, requestedDevice, signal } = input;
    const checks = await this.environmentChecks(input);
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

    if (input.skipPermissionProbe === true) {
      checks.push({
        name: "permissions",
        status: "notRun",
        message: "Permission probe deferred to verification"
      });
    } else if (deviceSerial === undefined) {
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

    return this.conclude(checks, {
      ...(deviceSerial === undefined ? {} : { deviceSerial })
    });
  }

  private async runForAssignments(
    input: DoctorRunInput,
    assignments: readonly DeviceAssignment[]
  ): Promise<DoctorReport> {
    const { packageName, signal } = input;
    const checks = await this.environmentChecks(input);

    let onlineSerials: Set<string>;
    let listingError: string | undefined;
    try {
      const devices = await this.dependencies.adb.devices(signal);
      onlineSerials = new Set(
        devices
          .filter((device) => device.status === "device")
          .map((device) => device.serial)
      );
    } catch (error) {
      onlineSerials = new Set();
      listingError = error instanceof Error ? error.message : String(error);
    }

    const deviceChecks: DoctorDeviceCheck[] = [];
    const appFailures: string[] = [];
    const permissionFailures: string[] = [];
    for (const assignment of assignments) {
      const online = onlineSerials.has(assignment.deviceSerial);
      const problems: string[] = [];
      if (!online) {
        problems.push(listingError !== undefined
          ? `Device listing failed: ${listingError}`
          : `Requested device is not online: ${assignment.deviceSerial}`);
      }
      let app: DoctorCheckStatus = "notRun";
      if (online && packageName !== undefined) {
        try {
          const installed = await this.dependencies.adb.isInstalled({
            packageName,
            deviceSerial: assignment.deviceSerial,
            ...(signal === undefined ? {} : { signal })
          });
          app = installed ? "passed" : "failed";
          if (!installed) {
            const message
              = `Package ${packageName} is not installed on ${assignment.deviceSerial}`;
            appFailures.push(message);
            problems.push(message);
          }
        } catch (error) {
          app = "failed";
          const message = error instanceof Error
            ? error.message
            : String(error);
          appFailures.push(message);
          problems.push(message);
        }
      }
      let permissions: DoctorCheckStatus = "notRun";
      if (online && input.skipPermissionProbe !== true) {
        try {
          const permission = await this.dependencies.checkAndroidPermissions(
            assignment.deviceSerial,
            signal
          );
          permissions = permission.status;
          if (permission.status === "failed") {
            if (permission.message !== undefined) {
              permissionFailures.push(permission.message);
              problems.push(permission.message);
            } else {
              permissionFailures.push(
                `Permission probe failed on ${assignment.deviceSerial}`
              );
            }
          }
        } catch (error) {
          permissions = "failed";
          const message = error instanceof Error
            ? error.message
            : String(error);
          permissionFailures.push(message);
          problems.push(message);
        }
      }
      deviceChecks.push({
        role: assignment.role,
        deviceSerial: assignment.deviceSerial,
        online,
        app,
        permissions,
        ...(problems.length === 0 ? {} : { message: problems.join("; ") })
      });
    }

    const offlineDevices = deviceChecks.filter((device) => !device.online);
    const appRan = deviceChecks.some((device) => device.app !== "notRun");
    const permissionsRan = deviceChecks.some(
      (device) => device.permissions !== "notRun"
    );

    const appStatus: DoctorCheckStatus = appFailures.length > 0
      ? "failed"
      : appRan
        ? "passed"
        : "notRun";
    checks.push({
      name: "app",
      status: appStatus,
      ...(appStatus === "failed"
        ? { message: appFailures.join("; ") }
        : appStatus === "passed"
          ? { message: packageName }
          : {
              message: packageName === undefined
                ? "Installed application probe requires a configured package"
                : "Installed application probe requires an online selected device"
            })
    });

    const permissionStatus: DoctorCheckStatus = permissionFailures.length > 0
      ? "failed"
      : permissionsRan
        ? "passed"
        : "notRun";
    checks.push({
      name: "permissions",
      status: permissionStatus,
      ...(permissionStatus === "failed"
        ? { message: permissionFailures.join("; ") }
        : permissionStatus === "notRun"
          ? {
              message: input.skipPermissionProbe === true
                ? "Permission probe deferred to verification"
                : "Permission probe requires an online selected device"
            }
          : {})
    });

    checks.push({
      name: "device",
      status: offlineDevices.length === 0 ? "passed" : "failed",
      ...(offlineDevices.length === 0
        ? {
            message: deviceChecks
              .map((device) => `${device.role}=${device.deviceSerial}`)
              .join(", ")
          }
        : {
            message: `Requested devices are not online: ${
              offlineDevices.map((device) => device.deviceSerial).join(", ")
            }`
          })
    });

    return this.conclude(checks, { devices: deviceChecks });
  }
}
