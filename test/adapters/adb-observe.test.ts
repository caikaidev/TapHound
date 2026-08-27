import { describe, expect, it, vi } from "vitest";

import { AdbAdapter } from "../../src/adapters/adb/adb-adapter.js";
import {
  commandResult,
  processRunner
} from "../fakes/process-runner.js";

describe("AdbAdapter.dumpLogcat", () => {
  it("invokes adb logcat -d -t <maxLines> on the selected device", async () => {
    const runner = processRunner(commandResult({ stdout: "line1\nline2\n" }));
    const adapter = new AdbAdapter(runner);
    const signal = new AbortController().signal;

    await adapter.dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 500,
      signal,
      timeoutMs: 2000
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: [
        "-s",
        "emulator-5554",
        "logcat",
        "-d",
        "-t",
        "500"
      ],
      signal,
      timeoutMs: 2000
    });
  });

  it("omits signal and timeoutMs from the spec when not provided", async () => {
    const runner = processRunner(commandResult());
    const adapter = new AdbAdapter(runner);

    await adapter.dumpLogcat({
      deviceSerial: "DEVICE1",
      maxLines: 100
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "adb",
      args: ["-s", "DEVICE1", "logcat", "-d", "-t", "100"]
    });
  });

  it("passes through non-zero exitCode transparently", async () => {
    const expected = commandResult({ exitCode: 1, stderr: "failure" });
    const runner = processRunner(expected);

    await expect(new AdbAdapter(runner).dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 200
    })).resolves.toBe(expected);
  });

  it("passes through timeout results transparently", async () => {
    const expected = commandResult({ timedOut: true, stdout: "" });
    const runner = processRunner(expected);

    await expect(new AdbAdapter(runner).dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 200,
      timeoutMs: 1000
    })).resolves.toBe(expected);
  });

  it("passes through spawnError transparently", async () => {
    const expected = commandResult({ spawnError: "ENOENT" });
    const runner = processRunner(expected);

    await expect(new AdbAdapter(runner).dumpLogcat({
      deviceSerial: "emulator-5554",
      maxLines: 200
    })).resolves.toBe(expected);
  });
});
