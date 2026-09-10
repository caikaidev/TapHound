import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { VerifyInput } from "../../src/application/runtime/verify-runtime.js";
import type { TargetResolver } from "../../src/application/target/target-resolver.js";
import type { LocalTargetService } from "../../src/application/target/local-target-service.js";
import { TargetError, type TargetEntry } from "../../src/domain/target.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
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
        runtimeBackend: "adb" as const,
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
    projectDescriber: {
      describe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextValidator: {
      validate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextLoader: {
      load: vi.fn(() => Promise.reject(new Error("unused"))),
      readIndex: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextRefresher: {
      refresh: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextGenerator: {
      generate: vi.fn(() => Promise.reject(new Error("unused")))
    },
    contextRehasher: {
      rehash: vi.fn(() => Promise.reject(new Error("unused")))
    },
    init: {
      install: vi.fn(() => Promise.reject(new Error("unused")))
    },
    initPrompt: {
      selectAgents: vi.fn(() => Promise.reject(new Error("unused")))
    },
    align: {
      alignCamera: vi.fn(() => Promise.reject(new Error("unused")))
    },
    observer: () => ({
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    }),
    generationStarter: {
      start: vi.fn(() => Promise.reject(new Error("unused")))
    },
    runtimeObserver: {
      observe: vi.fn(() => Promise.reject(new Error("unused")))
    },
    workspaceLayout: fakeWorkspaceLayout(),
    localTargets: defaultLocalTargets(),
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
    "node", "taphound", "verify",
    "--config", "/project/.taphound/config.json",
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
    expect(stderr).toContain("TapHound: verifying Search");
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
      runtimeBackend: "adb",
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

  it("refuses to run against a legacy workspace layout", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.workspaceLayout = fakeWorkspaceLayout([
      ".taphound/generations",
      ".taphound/runs"
    ]);

    await runVerify(dependencies);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string; message: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("CONFIG_INVALID");
    expect(output.failure.message).toContain(
      "mv .taphound/generations .taphound/build/generations"
    );
    expect(output.failure.message).toContain(
      "mv .taphound/runs .taphound/build/runs"
    );
    expect(output.failure.message).not.toContain(".taphound/jobs");
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([2]);
  });

  it("initializes the safe build layout before verification", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);

    await runVerify(dependencies);

    expect(dependencies.workspaceLayout).toMatchObject({
      initializedProjects: ["/project"]
    });
  });

  const TARGET_WORKSPACE = "/targets/.taphound/local/app";

  function targetDependencies(
    exitCodes: number[]
  ): CliDependencies {
    const dependencies = baseDependencies(exitCodes);
    dependencies.localTargets.targetResolver = (): TargetResolver => ({
      resolve: vi.fn(() => Promise.resolve({
        id: "app",
        sourceType: "local" as const,
        configuredPath: "/real/app",
        resolvedPath: "/real/app",
        project: { rootDir: "/real/app", settingsFile: "settings.gradle.kts" },
        workspaceRoot: TARGET_WORKSPACE
      })),
      resolveByPath: vi.fn(),
      fingerprint: vi.fn()
    } as unknown as TargetResolver);
    dependencies.localTargets.configStore = {
      ...dependencies.localTargets.configStore,
      loadTargets: vi.fn(() => Promise.resolve({
        targets: {
          app: {
            id: "app",
            source: { type: "local" as const, path: "/real/app" },
            run: {
              packageName: "com.example.app",
              activity: ".MainActivity"
            },
            git: { enabled: true },
            override: false
          }
        },
        official: undefined,
        local: undefined
      }))
    };
    dependencies.localTargets.localTargetService = (): LocalTargetService => ({
      configForTarget: (input: {
        entry: TargetEntry;
        resolvedPath: string;
        workspaceRoot: string;
      }) => ({
        version: 1,
        run: {
          packageName: input.entry.run.packageName,
          activity: input.entry.run.activity
        },
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 200,
          stablePolls: 2,
          timeoutMs: 5000
        },
        artifactsDir: `${input.workspaceRoot}/runs`
      })
    } as unknown as LocalTargetService);
    return dependencies;
  }

  it("verify --target reads the Journey from the workspace and runs there", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    dependencies.verifier.verify = vi.fn((input: VerifyInput) => {
      expect(input.projectRoot).toBe("/real/app");
      expect(input.workspaceRoot).toBe(TARGET_WORKSPACE);
      expect(input.config.artifactsDir).toBe(`${TARGET_WORKSPACE}/runs`);
      return Promise.resolve({
        status: "passed" as const,
        exitCode: 0 as const,
        report: validReport(),
        reportPath: "/reports/report.json",
        summaryPath: "/reports/summary.txt"
      });
    });

    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--target", "app",
      "--journey", "search",
      "--json"
    ]);

    const stdout = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { status: string; exitCode: number };
    expect(stdout.status).toBe("passed");
    expect(stdout.exitCode).toBe(0);
    expect(exitCodes).toEqual([0]);
    expect(dependencies.verifier.verify).toHaveBeenCalledTimes(1);
    const journeyPath = vi.mocked(dependencies.readJson).mock.calls
      .map((call) => call[0])
      .find((path) => path.includes("journeys"));
    expect(journeyPath).toBe(`${TARGET_WORKSPACE}/journeys/search.json`);
    expect(dependencies.workspaceLayout).toMatchObject({
      initializedProjects: []
    });
  });

  it("verify --target propagates APP_NOT_INSTALLED exit 3", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    dependencies.verifier.verify = vi.fn(() => Promise.resolve({
      status: "error" as const,
      exitCode: 3 as const,
      report: validReport({
        status: "error",
        primaryFailure: {
          code: "APP_NOT_INSTALLED",
          message: "missing",
          phase: "install"
        }
      }),
      reportPath: "/reports/report.json",
      summaryPath: "/reports/summary.txt"
    }));

    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--target", "app",
      "--journey", "search",
      "--json"
    ]);

    expect(JSON.parse((dependencies.stdout as BufferOutput).value))
      .toMatchObject({ exitCode: 3, status: "error" });
    expect(exitCodes).toEqual([3]);
  });

  it("verify --target uses exit 2 for an unknown id", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    dependencies.localTargets.targetResolver = (): TargetResolver => ({
      resolve: vi.fn(() => Promise.reject(new TargetError(
        "LOCAL_TARGET_NOT_FOUND",
        'Local target "missing" is not registered'
      ))),
      resolveByPath: vi.fn(),
      fingerprint: vi.fn()
    } as unknown as TargetResolver);

    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--target", "missing",
      "--journey", "search",
      "--json"
    ]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("LOCAL_TARGET_NOT_FOUND");
    expect(exitCodes).toEqual([2]);
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
  });

  it("verify --target fails code 2 when the Journey is missing", async () => {
    const exitCodes: number[] = [];
    const dependencies = targetDependencies(exitCodes);
    vi.mocked(dependencies.readJson).mockImplementation((path) => (
      Promise.reject(new Error(`ENOENT: ${path}`))
    ));

    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--target", "app",
      "--journey", "search",
      "--json"
    ]);

    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { exitCode: number; failure: { code: string } };
    expect(output.exitCode).toBe(2);
    expect(output.failure.code).toBe("CONFIG_INVALID");
    expect(exitCodes).toEqual([2]);
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
  });
});
