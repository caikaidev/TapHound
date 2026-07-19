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

function dependencies(): {
  value: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
} {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    value: {
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
      recorder: {
        record: vi.fn(() => Promise.resolve({
          status: "completed" as const,
          stepsRecorded: 1,
          journey: runtimeJourney
        }))
      },
      verifier: {
        verify: vi.fn(() => Promise.resolve({
          status: "passed" as const,
          exitCode: 0 as const,
          report: validReport(),
          reportPath: "/reports/run/report.json",
          summaryPath: "/reports/run/summary.txt"
        }))
      },
      readJson: vi.fn((path: string) => Promise.resolve(
        path.includes("journey") ? runtimeJourney : runtimeConfig
      )),
      cwd: () => "/project",
      stdout,
      stderr,
      setExitCode: (code): void => {
        exitCodes.push(code);
      }
    }
  };
}

describe("APR CLI commands", () => {
  it("prints a machine-readable doctor result", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "apr", "doctor", "--project", "/project", "--json"
    ]);

    expect(JSON.parse(test.stdout.value)).toMatchObject({ status: "passed" });
    expect(test.stderr.value).toBe("");
    expect(test.exitCodes).toEqual([0]);
  });

  it("loads config and invokes the interactive Recorder after preflight", async () => {
    const test = dependencies();

    await createProgram(test.value).parseAsync([
      "node", "apr", "record",
      "--project", "/project",
      "--config", "/project/apr.config.json",
      "--name", "Recorded",
      "--output", "/project/journeys/recorded.json"
    ]);

    expect(test.value.recorder.record).toHaveBeenCalledWith({
      config: runtimeConfig,
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      journeyName: "Recorded",
      outputPath: "/project/journeys/recorded.json"
    });
    expect(test.stdout.value).toContain("Recorded 1 step");
    expect(test.exitCodes).toEqual([0]);
  });

  it("applies verify Package, Activity, device, and report overrides", async () => {
    const test = dependencies();
    const signal = new AbortController().signal;
    Object.assign(test.value, { signal });

    await createProgram(test.value).parseAsync([
      "node", "apr", "verify",
      "--project", "/project",
      "--config", "/project/apr.config.json",
      "--journey", "/project/search.journey.json",
      "--device", "pixel-1",
      "--package", "com.override.app",
      "--activity", ".StartActivity",
      "--reports", "/tmp/apr-reports"
    ]);

    expect(test.value.doctor.run).toHaveBeenCalledWith(
      "/project",
      signal,
      "pixel-1"
    );
    const verifyInput = vi.mocked(test.value.verifier.verify).mock.calls[0]?.[0];
    expect(verifyInput).toMatchObject({
      projectRoot: "/project",
      deviceSerial: "pixel-1",
      config: {
        ...runtimeConfig,
        run: {
          packageName: "com.override.app",
          activity: ".StartActivity"
        },
        artifactsDir: "/tmp/apr-reports"
      },
      journey: runtimeJourney
    });
    expect(verifyInput?.signal).toBe(signal);
  });
});
