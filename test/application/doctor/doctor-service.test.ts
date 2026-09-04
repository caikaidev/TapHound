import { describe, expect, it, vi } from "vitest";

import { DoctorService } from "../../../src/application/doctor/doctor-service.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { CommandSpec, ProcessRunner } from "../../../src/ports/process-runner.js";
import { commandResult, runningCommand } from "../../fakes/process-runner.js";

function fixture(overrides: {
  nodeVersion?: string;
  devices?: Array<{ serial: string; status: string }>;
  installed?: boolean;
  permissions?: boolean;
  appium?: boolean;
  failures?: Record<string, string>;
} = {}): {
  service: DoctorService;
  checkPermissions: ReturnType<typeof vi.fn>;
} {
  const failures = overrides.failures ?? {};
  const runner: ProcessRunner = {
    run: vi.fn((spec: CommandSpec) => {
      const key = `${spec.executable} ${spec.args.join(" ")}`;
      const failure = failures[key];
      if (failure !== undefined) {
        return Promise.resolve(commandResult({
          exitCode: 1,
          stderr: failure
        }));
      }
      const stdout = spec.executable === "adb"
        ? "Android Debug Bridge version 1.0.41"
        : spec.args.includes("doctor")
          ? '{"permissions":"ok"}'
          : "Android CLI 0.1.0";
      return Promise.resolve(commandResult({ stdout }));
    }),
    start: vi.fn(() => runningCommand())
  };
  const adb: AdbPort = {
    devices: vi.fn(() => Promise.resolve(
      overrides.devices ?? [{ serial: "emulator-5554", status: "device" }]
    )),
    foregroundComponent: vi.fn(),
    currentActivity: vi.fn(),
    isInstalled: vi.fn(() => Promise.resolve(overrides.installed ?? true)),
    launchActivity: vi.fn(() => Promise.resolve(commandResult())),
    startActivityByIntent: vi.fn(),
    resolveLauncherActivity: vi.fn(() => Promise.resolve(undefined)),
    forceStop: vi.fn(),
    appProcesses: vi.fn(() => Promise.resolve([
      { pid: 42, name: "com.example.app" }
    ])),
    windowTopology: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn(),
    dumpLogcat: vi.fn()
  };
  const checkPermissions = vi.fn(() => Promise.resolve(
    overrides.permissions === false
      ? { status: "failed" as const, message: "Screen capture denied" }
      : { status: "passed" as const }
  ));
  return {
    checkPermissions,
    service: new DoctorService({
      runner,
      adb,
      nodeVersion: overrides.nodeVersion ?? "v24.3.0",
      checkAndroidPermissions: checkPermissions
      ,checkAppiumUiAutomator2: vi.fn(() => Promise.resolve(
        overrides.appium === false
          ? { status: "failed" as const, message: "Appium unavailable" }
          : { status: "passed" as const, version: "3.0.0" }
      ))
    })
  };
}

describe("DoctorService", () => {
  it("reports Node, ADB, Android CLI, app, permissions, and one device", async () => {
    const test = fixture();
    const report = await test.service.run({
      packageName: "com.example.app"
    });

    expect(report).toMatchObject({
      status: "passed",
      deviceSerial: "emulator-5554",
      checks: [
        { name: "node", status: "passed", version: "24.3.0" },
        { name: "adb", status: "passed" },
        { name: "android", status: "passed" },
        { name: "appium", status: "notRun" },
        { name: "app", status: "passed", message: "com.example.app" },
        { name: "permissions", status: "passed" },
        { name: "device", status: "passed" }
      ]
    });
    expect(test.checkPermissions).toHaveBeenCalledWith(
      "emulator-5554",
      undefined
    );
  });

  it("checks the locked Appium server and UiAutomator2 driver only when explicit", async () => {
    const passed = await fixture().service.run({
      packageName: "com.example.app",
      requestedUiBackend: "appium-uiautomator2"
    });
    const failed = await fixture({ appium: false }).service.run({
      requestedUiBackend: "appium-uiautomator2"
    });

    expect(passed.checks).toContainEqual(expect.objectContaining({
      name: "appium", status: "passed", version: "3.0.0"
    }));
    expect(failed).toMatchObject({
      status: "failed", failureCode: "ENVIRONMENT_MISSING_TOOL"
    });
  });

  it("skips the app probe when no package name is configured", async () => {
    const test = fixture();
    const report = await test.service.run();

    expect(report).toMatchObject({ status: "passed" });
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "app",
      status: "notRun"
    }));
  });

  it("rejects unsupported Node and missing tools as an environment failure", async () => {
    const report = await fixture({
      nodeVersion: "v20.0.0",
      failures: { "android --version": "command not found" }
    }).service.run({ packageName: "com.example.app" });

    expect(report).toMatchObject({
      status: "failed",
      failureCode: "ENVIRONMENT_MISSING_TOOL"
    });
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "node",
      status: "failed"
    }));
  });

  it("requires exactly one online device", async () => {
    const none = await fixture({ devices: [] }).service.run({
      packageName: "com.example.app"
    });
    const many = await fixture({ devices: [
      { serial: "one", status: "device" },
      { serial: "two", status: "device" }
    ] }).service.run({ packageName: "com.example.app" });
    const offline = await fixture({
      devices: [{ serial: "one", status: "offline" }]
    }).service.run({ packageName: "com.example.app" });

    expect(none.failureCode).toBe("DEVICE_UNAVAILABLE");
    expect(many.failureCode).toBe("DEVICE_UNAVAILABLE");
    expect(offline.failureCode).toBe("DEVICE_UNAVAILABLE");
  });

  it("reports an uninstalled app as APP_NOT_INSTALLED", async () => {
    const report = await fixture({
      installed: false
    }).service.run({ packageName: "com.example.app" });

    expect(report.failureCode).toBe("APP_NOT_INSTALLED");
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "app",
      status: "failed"
    }));
  });

  it("reports Android permission diagnostic failures", async () => {
    const report = await fixture({
      permissions: false
    }).service.run({ packageName: "com.example.app" });

    expect(report.failureCode).toBe("ENVIRONMENT_MISSING_TOOL");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "permissions", status: "failed" })
    ]));
  });
});
