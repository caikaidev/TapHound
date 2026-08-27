import { describe, expect, it, vi } from "vitest";

import {
  SkillPayloadMissingError
} from "../../src/adapters/filesystem/skill-installer.js";
import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { AgentId, InitResult } from "../../src/domain/init.js";
import {
  InitPromptCancelledError
} from "../../src/ports/init-prompt.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

interface InitFailureOutput {
  status: "error";
  exitCode: number;
  failure: { code: string; message: string };
}

interface InitTestHarness {
  dependencies: CliDependencies;
  stdout: BufferOutput;
  stderr: BufferOutput;
  exitCodes: number[];
  installMock: ReturnType<typeof vi.fn<(input: unknown) => Promise<InitResult>>>;
  selectAgentsMock: ReturnType<typeof vi.fn<() => Promise<AgentId[]>>>;
}

const defaultInstallResult: InitResult = {
  status: "installed",
  exitCode: 0,
  agents: ["claude", "droid"],
  paths: [
    ".claude/skills/taphound-ai-journey",
    ".factory/skills/taphound-ai-journey"
  ]
};

function harness(
  selectAgentsImpl?: () => Promise<AgentId[] | never[]>
): InitTestHarness {
  const stdout = new BufferOutput();
  const stderr = new BufferOutput();
  const exitCodes: number[] = [];
  const installMock = vi.fn<() => Promise<InitResult>>(
    () => Promise.resolve(defaultInstallResult)
  );
  const selectAgentsMock = vi.fn<() => Promise<AgentId[]>>(
    () => Promise.resolve(
      selectAgentsImpl !== undefined
        ? selectAgentsImpl() as Promise<AgentId[]>
        : ["claude", "droid"]
    )
  );
  const dependencies: CliDependencies = {
    doctor: { run: vi.fn(() => Promise.reject(new Error("unused"))) },
    recorder: { record: vi.fn(() => Promise.reject(new Error("unused"))) },
    verifier: { verify: vi.fn(() => Promise.reject(new Error("unused"))) },
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
    init: { install: installMock },
    initPrompt: { selectAgents: selectAgentsMock },
    align: { alignCamera: vi.fn(() => Promise.reject(new Error("unused"))) },
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
    readJson: vi.fn(() => Promise.reject(new Error("unused"))),
    cwd: () => "/project",
    stdout,
    stderr,
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
  return {
    dependencies,
    stdout,
    stderr,
    exitCodes,
    installMock,
    selectAgentsMock
  };
}

function parseOutput(stdout: BufferOutput): InitResult | InitFailureOutput {
  return JSON.parse(stdout.value) as InitResult | InitFailureOutput;
}

describe("taphound init command", () => {
  it("installs agents specified via --agent flag", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "claude,droid", "--json"
    ]);

    expect(test.selectAgentsMock).not.toHaveBeenCalled();
    expect(test.installMock).toHaveBeenCalledWith({
      agents: ["claude", "droid"],
      global: false
    });
    expect(parseOutput(test.stdout)).toMatchObject({
      status: "installed",
      exitCode: 0,
      agents: ["claude", "droid"]
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("uses interactive prompt when --agent is not provided", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--json"
    ]);

    expect(test.selectAgentsMock).toHaveBeenCalledTimes(1);
    expect(test.installMock).toHaveBeenCalledWith({
      agents: ["claude", "droid"],
      global: false
    });
    expect(test.exitCodes).toEqual([0]);
  });

  it("passes --global flag to the service", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "claude", "--global", "--json"
    ]);

    expect(test.installMock).toHaveBeenCalledWith({
      agents: ["claude"],
      global: true
    });
  });

  it("errors with UNKNOWN_AGENT for an invalid agent id", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "unknown", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "UNKNOWN_AGENT" }
    });
    expect(test.exitCodes).toEqual([2]);
    expect(test.installMock).not.toHaveBeenCalled();
  });

  it("errors with NO_AGENTS_SELECTED when --agent is empty", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "NO_AGENTS_SELECTED" }
    });
    expect(test.exitCodes).toEqual([2]);
    expect(test.installMock).not.toHaveBeenCalled();
  });

  it("errors with NO_AGENTS_SELECTED when prompt returns empty", async () => {
    const test = harness(() => Promise.resolve([]));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "NO_AGENTS_SELECTED" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("errors with NO_AGENTS_SELECTED when prompt is cancelled", async () => {
    const test = harness(() => Promise.reject(new InitPromptCancelledError()));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "NO_AGENTS_SELECTED" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("errors with NO_AGENTS_SELECTED when prompt requires TTY", async () => {
    const test = harness(() => Promise.reject(
      new Error("Agent selection requires local TTY input and output")
    ));

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "NO_AGENTS_SELECTED" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("errors with SKILL_PAYLOAD_MISSING when payload is not found", async () => {
    const test = harness();
    test.installMock.mockRejectedValueOnce(
      new SkillPayloadMissingError("/nonexistent/payload")
    );

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "claude", "--json"
    ]);

    expect(parseOutput(test.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "SKILL_PAYLOAD_MISSING" }
    });
    expect(test.exitCodes).toEqual([2]);
  });

  it("writes human-readable output without --json", async () => {
    const test = harness();

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "claude,droid"
    ]);

    expect(test.stdout.value).toContain("Installed TapHound Skill");
    expect(test.stdout.value).toContain("claude, droid");
    expect(test.stdout.value).toContain(".claude/skills/taphound-ai-journey");
    expect(test.exitCodes).toEqual([0]);
  });

  it("includes skipped paths in output when present", async () => {
    const test = harness();
    const resultWithSkipped: InitResult = {
      status: "installed",
      exitCode: 0,
      agents: ["claude", "droid"],
      paths: [".claude/skills/taphound-ai-journey"],
      skipped: [".factory/skills/taphound-ai-journey"]
    };
    test.installMock.mockResolvedValueOnce(resultWithSkipped);

    await createProgram(test.dependencies).parseAsync([
      "node", "taphound", "init", "--agent", "claude,droid", "--json"
    ]);

    const output = parseOutput(test.stdout);
    expect(output).toHaveProperty("skipped");
    expect((output as InitResult).skipped).toEqual([
      ".factory/skills/taphound-ai-journey"
    ]);
  });
});
