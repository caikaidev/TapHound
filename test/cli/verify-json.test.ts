import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { validReport } from "../fixtures/report.js";
import { hashJourney } from "../../src/domain/report.js";

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
    readFile: vi.fn(() => Promise.resolve(Buffer.alloc(0))),
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

async function runVerify(
  dependencies: CliDependencies,
  extra: string[] = []
): Promise<void> {
  await createProgram(dependencies).parseAsync([
    "node", "taphound", "verify",
    "--config", "/project/.taphound/config.json",
    "--journey", "/project/search.journey.json",
    "--json",
    ...extra
  ]);
}

describe("verify --json", () => {
  const policy = {
    generatedReplayPolicy: true,
    requireFocusedInput: true,
    idle: {
      strategy: "structural" as const,
      pollIntervalMs: 250,
      stablePolls: 4,
      timeoutMs: 45000
    }
  };
  const meta = {
    version: 1,
    status: "verified",
    generationId: "generation-1",
    journeyPath: "search.journey.json",
    journeySha256: hashJourney(runtimeJourney),
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64)
    },
    replayPolicy: policy,
    verification: {
      reportPath: "verification/report.json",
      reportSha256: "d".repeat(64),
      runId: "verify-run",
      runs: 1
    },
    manualOverrideStepIndexes: []
  };

  it("applies the bound strict policy and idle settings before device preflight", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    vi.mocked(dependencies.readJson).mockImplementation((path) => Promise.resolve(
      path.endsWith(".meta.json") ? meta
        : path.includes("journey") ? runtimeJourney : runtimeConfig
    ));

    await runVerify(dependencies, ["--policy-from-meta"]);

    expect(dependencies.readJson).toHaveBeenCalledWith("/project/search.journey.meta.json");
    expect(dependencies.verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      generatedReplayPolicy: true,
      requireFocusedInput: true,
      config: expect.objectContaining({ idle: policy.idle }) as unknown
    }));
    expect(JSON.parse((dependencies.stdout as BufferOutput).value)).toMatchObject({
      status: "passed",
      exitCode: 0
    });
    expect(exitCodes).toEqual([0]);
  });

  it.each([
    ["missing sidecar", undefined],
    ["old sidecar", { ...meta, replayPolicy: undefined }],
    ["changed Journey", { ...meta, journeySha256: "f".repeat(64) }],
    ["different path", { ...meta, journeyPath: "another.json" }],
    ["non-strict sidecar", {
      ...meta,
      replayPolicy: { ...policy, requireFocusedInput: false }
    }]
  ])("fails closed for %s with one JSON value", async (_label, sidecar) => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    vi.mocked(dependencies.readJson).mockImplementation((path) => (
      path.endsWith(".meta.json")
        ? sidecar === undefined
          ? Promise.reject(new Error("missing"))
          : Promise.resolve(sidecar)
        : Promise.resolve(path.includes("journey") ? runtimeJourney : runtimeConfig)
    ));

    await runVerify(dependencies, ["--policy-from-meta"]);

    expect(JSON.parse((dependencies.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 2,
      failure: { code: "REPLAY_POLICY_UNAVAILABLE" }
    });
    expect((dependencies.stdout as BufferOutput).value.trim().split("\n")).toHaveLength(1);
    expect(dependencies.doctor.run).not.toHaveBeenCalled();
    expect(dependencies.verifier.verify).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([2]);
  });

  it("rejects strict-policy diff mode rather than silently weakening it", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--diff", "HEAD^",
      "--policy-from-meta", "--json"
    ]);
    expect(JSON.parse((dependencies.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(dependencies.doctor.run).not.toHaveBeenCalled();
  });
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
});
