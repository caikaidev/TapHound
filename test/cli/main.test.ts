import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  runMain,
  withTerminationSignal
} from "../../src/cli/main.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";

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

    await runMain(["node", "apr", "verify", "--json"], test);

    expect(JSON.parse((test.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect((test.stderr as BufferOutput).value)
      .toContain("required option '--journey <path>' not specified");
    expect(exitCodes).toEqual([2]);
  });

  it("maps unexpected top-level setup errors to INTERNAL_ERROR exit 4", async () => {
    const exitCodes: number[] = [];
    const test = dependencies(exitCodes);
    test.cwd = (): string => {
      throw new Error("cwd unavailable");
    };

    await runMain(["node", "apr", "doctor", "--json"], test);

    expect(JSON.parse((test.stdout as BufferOutput).value)).toMatchObject({
      exitCode: 4,
      failure: { code: "INTERNAL_ERROR", message: "cwd unavailable" }
    });
    expect(exitCodes).toEqual([4]);
  });
});
