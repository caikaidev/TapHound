import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  runMain,
  withTerminationSignal
} from "../../src/cli/main.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { UiCaptureTelemetry } from "../../src/application/diagnostics/ui-capture-telemetry.js";
import type { CommandEvent } from "../../src/domain/diagnostics.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

function dependencies(exitCodes: number[]): CliDependencies {
  return {
    doctor: { run: () => Promise.reject(new Error("unused")) },
    recorder: { record: () => Promise.reject(new Error("unused")) },
    verifier: { verify: () => Promise.reject(new Error("unused")) },
    projectDescriber: {
      describe: () => Promise.reject(new Error("unused"))
    },
    contextValidator: {
      validate: () => Promise.reject(new Error("unused"))
    },
    contextLoader: {
      load: () => Promise.reject(new Error("unused")),
      readIndex: () => Promise.reject(new Error("unused"))
    },
    contextRefresher: {
      refresh: () => Promise.reject(new Error("unused"))
    },
    contextGenerator: {
      generate: () => Promise.reject(new Error("unused"))
    },
    contextRehasher: {
      rehash: () => Promise.reject(new Error("unused"))
    },
    init: {
      install: () => Promise.reject(new Error("unused"))
    },
    initPrompt: {
      selectAgents: () => Promise.reject(new Error("unused"))
    },
    align: {
      alignCamera: () => Promise.reject(new Error("unused"))
    },
    observer: () => ({
      observe: () => Promise.reject(new Error("unused"))
    }),
    generationStarter: {
      start: () => Promise.reject(new Error("unused"))
    },
    runtimeObserver: {
      observe: () => Promise.reject(new Error("unused"))
    },
    workspaceLayout: fakeWorkspaceLayout(),
    readFile: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0)),
    readJson: (path) => Promise.resolve(
      path.includes("journey") ? runtimeJourney : runtimeConfig
    ),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

describe("runMain", () => {
  it("turns SIGINT into an AbortSignal and removes process listeners", async () => {
    const events = new EventEmitter();
    let observed: AbortSignal | undefined;

    await withTerminationSignal((signal) => {
      observed = signal;
      events.emit("SIGINT");
      return Promise.resolve();
    }, events);

    expect(observed?.aborted).toBe(true);
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
  });

  it("maps Commander usage errors to CONFIG_INVALID exit 2", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);

    await runMain(["node", "taphound", "verify", "--json"], test);

    expect(JSON.parse((test.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(exitCodes).toEqual([2]);
  });

  it("keeps nested command usage errors out of JSON stdout", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);

    await runMain([
      "node", "taphound", "generation", "observe", "--json"
    ], test);

    const stdout = (test.stdout as BufferOutput).value;
    expect(JSON.parse(stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect((test.stderr as BufferOutput).value)
      .toContain("required option '--session <id>' not specified");
    expect(exitCodes).toEqual([2]);
  });

  it("journals the finished invocation with its structured outcome", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);
    const appended: Array<{ projectRoot: string; event: CommandEvent }> = [];
    test.diagnostics = {
      journal: {
        append: (projectRoot, event): Promise<void> => {
          appended.push({ projectRoot, event });
          return Promise.resolve();
        },
        readLines: (): Promise<string[]> => Promise.resolve([]),
        salt: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(32))
      },
      telemetry: new UiCaptureTelemetry()
    };

    await runMain([
      "node", "taphound", "verify", "--journey", "secret.json", "--json"
    ], test);

    expect(exitCodes).toEqual([2]);
    expect(appended).toMatchObject([{
      projectRoot: "/project",
      event: {
        command: "verify",
        flags: ["journey", "json"],
        exitCode: 2,
        status: "error",
        failureCode: "CONFIG_INVALID",
        ui: []
      }
    }]);
    expect(JSON.stringify(appended)).not.toContain("secret.json");
  });

  it("never lets a journal failure change the command result", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);
    test.diagnostics = {
      journal: {
        append: (): Promise<void> => Promise.reject(new Error("disk full")),
        readLines: (): Promise<string[]> => Promise.resolve([]),
        salt: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(32))
      },
      telemetry: new UiCaptureTelemetry()
    };

    await runMain(["node", "taphound", "verify", "--journey", "j.json", "--json"], test);

    const stdout = (test.stdout as BufferOutput).value;
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 2 });
    expect((test.stderr as BufferOutput).value).not.toContain("disk full");
    expect(exitCodes).toEqual([2]);
  });

  it("maps unexpected top-level setup errors to INTERNAL_ERROR exit 4", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);
    test.cwd = (): string => {
      throw new Error("cwd unavailable");
    };

    await runMain(["node", "taphound", "doctor", "--json"], test);

    expect(JSON.parse((test.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 4,
      failure: { code: "INTERNAL_ERROR", message: "cwd unavailable" }
    });
    expect(exitCodes).toEqual([4]);
  });
});
