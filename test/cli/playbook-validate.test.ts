import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { PlaybookValidateOutput } from "../../src/application/playbook/playbook-validator.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

function baseDependencies(
  exitCodes: number[],
  output: PlaybookValidateOutput
): CliDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: []
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    playbookValidator: { validate: vi.fn(() => Promise.resolve(output)) },
    projectDescriber: { describe: vi.fn() },
    contextValidator: { validate: vi.fn() },
    contextLoader: { load: vi.fn(), readIndex: vi.fn() },
    contextRefresher: { refresh: vi.fn() },
    contextGenerator: { generate: vi.fn() },
    contextRehasher: { rehash: vi.fn() },
    init: { install: vi.fn() },
    initPrompt: { selectAgents: vi.fn() },
    align: { alignCamera: vi.fn() },
    observer: (): { observe: () => Promise<never> } => ({ observe: vi.fn() }),
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

const validOutput: PlaybookValidateOutput = {
  status: "valid",
  playbooks: [{ id: "search-fd", ok: true, issues: [] }]
};

const invalidOutput: PlaybookValidateOutput = {
  status: "invalid",
  playbooks: [{
    id: "search-fd",
    ok: false,
    issues: ["Bound Contract drifted"]
  }]
};

describe("playbook validate", () => {
  it("emits a valid status with exit code 0", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, validOutput);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "playbook", "validate",
      "--project", "/project",
      "--playbook", ".taphound/playbooks/search-fd.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as PlaybookValidateOutput;
    expect(output.status).toBe("valid");
    expect(output.playbooks[0]?.ok).toBe(true);
  });

  it("emits an invalid status with exit code 2", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, invalidOutput);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "playbook", "validate",
      "--project", "/project",
      "--playbook", ".taphound/playbooks/search-fd.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as PlaybookValidateOutput;
    expect(output.status).toBe("invalid");
    expect(output.playbooks[0]?.issues[0]).toContain("drifted");
  });

  it("handles multiple comma-separated playbooks", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, validOutput);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "playbook", "validate",
      "--project", "/project",
      "--playbook", "a.json,b.json",
      "--json"
    ]);
    const validate = dependencies.playbookValidator?.validate as ReturnType<typeof vi.fn>;
    expect(validate).toHaveBeenCalledWith({
      projectRoot: "/project",
      playbookPaths: ["/project/a.json", "/project/b.json"]
    });
  });

  it("fails when validation is not configured", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes, validOutput);
    dependencies.playbookValidator = undefined;
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "playbook", "validate",
      "--project", "/project",
      "--playbook", "a.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { failure: { code: string } };
    expect(output.failure.code).toBe("CONFIG_INVALID");
  });
});