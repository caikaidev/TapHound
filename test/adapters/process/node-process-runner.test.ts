import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeProcessRunner } from "../../../src/adapters/process/node-process-runner.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/bin/fake-command.mjs", import.meta.url)
);

describe("NodeProcessRunner", () => {
  it("preserves argument boundaries without a shell", async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [fixture, "args", "value with spaces", "$(uname)"]
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["value with spaces", "$(uname)"]);
  });

  it("forwards cwd and merged environment variables", async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [fixture, "inspect"],
      cwd: process.cwd(),
      env: { TAPHOUND_TEST_VALUE: "forwarded" }
    });

    expect(JSON.parse(result.stdout)).toEqual({
      cwd: process.cwd(),
      value: "forwarded"
    });
  });

  it("captures stdout, stderr, and a nonzero exit code", async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [fixture, "io"]
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "standard output",
      stderr: "standard error",
      timedOut: false,
      cancelled: false
    });
  });

  it("terminates a command after its timeout", async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [fixture, "sleep"],
      timeoutMs: 50
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it("applies a default timeout to finite run commands", async () => {
    const runner = new NodeProcessRunner(25);

    const result = await runner.run({
      executable: process.execPath,
      args: [fixture, "sleep"]
    });

    expect(result.timedOut).toBe(true);
  });

  it("terminates a command when its AbortSignal is cancelled", async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();

    const completion = runner.run({
      executable: process.execPath,
      args: [fixture, "sleep"],
      signal: controller.signal
    });
    controller.abort();

    await expect(completion).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: true
    });
  });

  it("streams complete stdout lines and stops idempotently", async () => {
    const runner = new NodeProcessRunner();
    const lines: string[] = [];
    let resolveSecond: (() => void) | undefined;
    const secondLine = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    const running = runner.start(
      {
        executable: process.execPath,
        args: [fixture, "stream"]
      },
      {
        onStdoutLine(line) {
          lines.push(line);
          if (line === "second") {
            resolveSecond?.();
          }
        }
      }
    );

    await expect(running.started).resolves.toBeUndefined();
    await secondLine;
    const firstStop = running.stop();
    const secondStop = running.stop();

    expect(firstStop).toBe(secondStop);
    await expect(firstStop).resolves.toMatchObject({ exitCode: null });
    expect(lines).toEqual(["first", "second"]);
  });

  it("reports a streaming command that exits during startup", async () => {
    const runner = new NodeProcessRunner(15 * 60 * 1000, 500);

    const running = runner.start({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('startup failed'); process.exit(7)"]
    });

    await expect(running.started).resolves.toMatchObject({
      exitCode: 7,
      stderr: "startup failed"
    });
  });

  it("reports a streaming executable that cannot be spawned", async () => {
    const runner = new NodeProcessRunner();

    const running = runner.start({
      executable: "/taphound-fixture/missing-executable",
      args: []
    });

    const startup = await running.started;
    expect(startup?.exitCode).toBe(-2);
    expect(startup?.spawnError).toMatch(/ENOENT/);
  });
});
