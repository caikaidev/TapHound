import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { validReport } from "../fixtures/report.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

function baseDependencies(exitCodes: number[]): CliDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.3.0" },
          { name: "adb" as const, status: "passed" as const, version: "1.0.41" },
          { name: "android" as const, status: "passed" as const, version: "0.1.0" }
        ]
      }))
    },
    recorder: { record: vi.fn() },
    verifier: {
      verify: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        exitCode: 0 as const,
        report: validReport(),
        reportPath: "/reports/report.json",
        summaryPath: "/reports/summary.txt"
      }))
    },
    readJson: vi.fn((path: string) => Promise.resolve(
      path.includes("journey") ? runtimeJourney : runtimeConfig
    )),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

async function runVerify(dependencies: CliDependencies): Promise<void> {
  await createProgram(dependencies).parseAsync([
    "node", "apr", "verify",
    "--config", "/project/apr.config.json",
    "--journey", "/project/search.journey.json",
    "--json"
  ]);
}

describe("verify --json", () => {
  it("writes exactly one JSON value to stdout and diagnostics to stderr", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);

    await runVerify(dependencies);

    const stdout = (dependencies.stdout as BufferOutput).value;
    const stderr = (dependencies.stderr as BufferOutput).value;
    expect(JSON.parse(stdout)).toMatchObject({
      status: "passed",
      exitCode: 0,
      reportPath: "/reports/report.json"
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("APR: verifying Search");
    expect(exitCodes).toEqual([0]);
  });

  it.each([
    [1, "verification", "failed"],
    [4, "internal", "error"]
  ] as const)("propagates exit code %s for %s outcomes", async (exitCode, _label, status) => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    if (exitCode === 4) {
      vi.mocked(dependencies.verifier.verify).mockRejectedValue(new Error("boom"));
    } else {
      vi.mocked(dependencies.verifier.verify).mockResolvedValue({
        status,
        exitCode,
        report: validReport({
          status: "failed",
          primaryFailure: {
            code: "LOCATOR_NOT_FOUND",
            message: "missing",
            phase: "replay"
          }
        }),
        reportPath: "/reports/report.json",
        summaryPath: "/reports/summary.txt"
      });
    }

    await runVerify(dependencies);

    expect(JSON.parse((dependencies.stdout as BufferOutput).value))
      .toMatchObject({ exitCode });
    expect(exitCodes).toEqual([exitCode]);
  });

  it("uses exit 2 for invalid config and exit 3 for preflight failure", async () => {
    const invalidCodes: number[] = [];
    const invalid = baseDependencies(invalidCodes);
    vi.mocked(invalid.readJson).mockResolvedValue({ version: 999 });
    await runVerify(invalid);
    expect(JSON.parse((invalid.stdout as BufferOutput).value))
      .toMatchObject({ exitCode: 2, failure: { code: "CONFIG_INVALID" } });

    const environmentCodes: number[] = [];
    const environment = baseDependencies(environmentCodes);
    vi.mocked(environment.doctor.run).mockResolvedValue({
      status: "failed",
      failureCode: "DEVICE_UNAVAILABLE",
      checks: [{
        name: "device",
        status: "failed",
        message: "no device"
      }]
    });
    await runVerify(environment);
    expect(JSON.parse((environment.stdout as BufferOutput).value))
      .toMatchObject({
        exitCode: 3,
        failure: { code: "DEVICE_UNAVAILABLE" }
      });
    expect(invalidCodes).toEqual([2]);
    expect(environmentCodes).toEqual([3]);
  });
});
