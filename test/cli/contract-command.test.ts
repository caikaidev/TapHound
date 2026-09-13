import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { ContractVerifyInput, ContractVerifyResult } from "../../src/application/contract/contract-verifier.js";
import type { ContractVerdictView } from "../../src/domain/contract.js";
import type { ObserveInput } from "../../src/application/observe/observe-service.js";
import type { ObserveReport } from "../../src/domain/observation.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { hashJourney } from "../../src/domain/report.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";

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
    verifier: { verify: vi.fn() },
    projectDescriber: { describe: vi.fn() },
    contextValidator: { validate: vi.fn() },
    contextLoader: { load: vi.fn(), readIndex: vi.fn() },
    contextRefresher: { refresh: vi.fn() },
    contextGenerator: { generate: vi.fn() },
    contextRehasher: { rehash: vi.fn() },
    init: { install: vi.fn() },
    initPrompt: { selectAgents: vi.fn() },
    align: { alignCamera: vi.fn() },
    observer: (): {
      observe: (input: ObserveInput) => Promise<ObserveReport>;
    } => ({ observe: vi.fn() }),
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
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


function verdictView(): ContractVerdictView {
  return {
    version: 1 as const,
    contractId: "search-opens",
    contractSha256: "a".repeat(64),
    journeySha256: "b".repeat(64),
    verdict: "pass" as const,
    reason: "CONTRACT_OK" as const,
    message: "Acceptance Contract satisfied by runtime evidence",
    preconditions: [{ kind: "installed" as const, status: "passed" as const }],
    assertions: [{ type: "element" as const, status: "passed" as const }],
    evidence: [{
      kind: "screenshot" as const,
      required: true,
      satisfied: true
    }],
    reportPath: "/project/.taphound/build/runs/run-1/report.json",
    reportStatus: "passed" as const,
    startedAt: "2026-07-19T10:00:00.000Z",
    finishedAt: "2026-07-19T10:00:05.000Z",
    environment: {
      projectRoot: "/project",
      packageName: "com.example.app",
      devices: ["emulator-5554"]
    }
  };
}

describe("verify --contract", () => {
  it("requires exactly one of --journey or --contract", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify", "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      failure: { code: string };
    };
    expect(output.failure.code).toBe("CONFIG_INVALID");
  });

  it("emits one JSON verdict on success and a zero exit code", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.contractVerifier = {
      verify: vi.fn((_input: ContractVerifyInput): Promise<ContractVerifyResult> => {
        expect(_input.contractPath).toBe("/project/contracts/search.json");
        expect(_input.devices[0]?.deviceSerial).toBe("emulator-5554");
        return Promise.resolve({ view: verdictView(), exitCode: 0 });
      })
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--config", "/project/.taphound/config.json",
      "--contract", "contracts/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      verdict: string;
      reason: string;
    };
    expect(output.verdict).toBe("pass");
    expect(output.reason).toBe("CONTRACT_OK");
  });

  it("propagates the verdict exit code for a fail verdict", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.contractVerifier = {
      verify: vi.fn((): Promise<ContractVerifyResult> => Promise.resolve({
        view: {
          ...verdictView(),
          verdict: "fail" as const,
          reason: "RUN_FAILED" as const
        },
        exitCode: 4
      }))
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--config", "/project/.taphound/config.json",
      "--contract", "contracts/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([4]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      verdict: string;
    };
    expect(output.verdict).toBe("fail");
  });

  it("rejects --contract together with --target", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "verify",
      "--config", "/project/.taphound/config.json",
      "--contract", "contracts/search.json",
      "--target", "demo",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
  });
});

describe("contract validate", () => {
  it("validates a contract and emits one JSON value", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    const journeyHash = hashJourney(runtimeJourney);
    const loaded = {
      contract: {
        version: 1 as const,
        id: "search-opens",
        goal: "Tapping search opens the search screen",
        journey: {
          path: ".taphound/journeys/search.json",
          sha256: journeyHash
        },
        preconditions: [{ kind: "installed" as const }],
        assertions: [{
          type: "element" as const,
          locator: { resourceId: "search" },
          visibility: "visible" as const,
          timeoutMs: 2000
        }],
        evidenceRequirements: []
      },
      contractSha256: "a".repeat(64),
      journey: runtimeJourney,
      journeyPath: "/project/.taphound/journeys/search.json"
    };
    dependencies.contractLoader = {
      load: vi.fn(() => Promise.resolve(loaded))
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "contract",
      "--contract", "contracts/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      status: string;
      contractId: string;
      contractSha256: string;
    };
    expect(output.status).toBe("valid");
    expect(output.contractId).toBe("search-opens");
    expect(output.contractSha256).toBe("a".repeat(64));
  });

  it("reports an invalid contract with exit code 2", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.contractLoader = {
      load: vi.fn(() => Promise.reject(
        Object.assign(new Error("drifted"), { code: "CONTRACT_JOURNEY_DRIFT" })
      ))
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "contract",
      "--contract", "contracts/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      failure: { code: string };
    };
    expect(output.failure.code).toBe("CONTRACT_JOURNEY_DRIFT");
  });
});