import { describe, expect, it, vi } from "vitest";

import { DoctorService } from "../../../src/application/doctor/doctor-service.js";
import type { AdbPort } from "../../../src/ports/adb.js";
import type { CommandSpec, ProcessRunner } from "../../../src/ports/process-runner.js";
import { commandResult, runningCommand } from "../../fakes/process-runner.js";

function fixture(overrides: {
  nodeVersion?: string;
  devices?: Array<{ serial: string; status: string }>;
  gradle?: boolean;
  permissions?: boolean;
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
    currentActivity: vi.fn(),
    pid: vi.fn(),
    tap: vi.fn(),
    longClick: vi.fn(),
    swipe: vi.fn(),
    back: vi.fn(),
    inputText: vi.fn(),
    startLogcat: vi.fn()
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
      checkGradleWrapper: vi.fn(() => Promise.resolve(overrides.gradle ?? true)),
      checkAndroidPermissions: checkPermissions
    })
  };
}

describe("DoctorService", () => {
  it("reports Node, ADB, Android CLI, Gradle, permissions, and one device", async () => {
    const test = fixture();
    const report = await test.service.run("/project");

    expect(report).toMatchObject({
      status: "passed",
      deviceSerial: "emulator-5554",
      checks: [
        { name: "node", status: "passed", version: "24.3.0" },
        { name: "adb", status: "passed" },
        { name: "android", status: "passed" },
        { name: "gradle", status: "passed" },
        { name: "permissions", status: "passed" },
        { name: "device", status: "passed" }
      ]
    });
    expect(test.checkPermissions).toHaveBeenCalledWith(
      "emulator-5554",
      undefined
    );
  });

  it("rejects unsupported Node and missing tools as an environment failure", async () => {
    const report = await fixture({
      nodeVersion: "v20.0.0",
      failures: { "android --version": "command not found" }
    }).service.run("/project");

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
    const none = await fixture({ devices: [] }).service.run("/project");
    const many = await fixture({ devices: [
      { serial: "one", status: "device" },
      { serial: "two", status: "device" }
    ] }).service.run("/project");
    const offline = await fixture({
      devices: [{ serial: "one", status: "offline" }]
    }).service.run("/project");

    expect(none.failureCode).toBe("DEVICE_UNAVAILABLE");
    expect(many.failureCode).toBe("DEVICE_UNAVAILABLE");
    expect(offline.failureCode).toBe("DEVICE_UNAVAILABLE");
  });

  it("reports Gradle wrapper and Android permission diagnostic failures", async () => {
    const report = await fixture({
      gradle: false,
      permissions: false
    }).service.run("/project");

    expect(report.failureCode).toBe("ENVIRONMENT_MISSING_TOOL");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "gradle", status: "failed" }),
      expect.objectContaining({ name: "permissions", status: "failed" })
    ]));
  });
});
