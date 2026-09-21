import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  DetachedProcessInput,
  DetachedProcessLauncher
} from "../../ports/detached-process-launcher.js";

const DETACHED_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const { open, stat, writeFile } = require("node:fs/promises");
const input = JSON.parse(process.argv[1]);
const failure = async (exitCode, signal, message) => {
  const output = {
    status: "error",
    exitCode: typeof exitCode === "number" && exitCode > 0 ? exitCode : 1,
    failure: {
      code: "DETACHED_PROCESS_CRASHED",
      message,
      details: { exitCode, signal }
    }
  };
  const info = await stat(input.stdoutPath).catch(() => ({ size: 0 }));
  if (info.size === 0) {
    await writeFile(input.stdoutPath, JSON.stringify(output) + "\n", "utf8");
  }
};
(async () => {
  const stdout = await open(input.stdoutPath, "r+");
  const stderr = await open(input.stderrPath, "r+");
  let child;
  try {
    child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", stdout.fd, stderr.fd]
    });
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    if (result.error !== undefined) {
      await failure(null, null, "Detached process failed to start: " + result.error.message);
    } else if (result.exitCode !== 0 || result.signal !== null) {
      await failure(
        result.exitCode,
        result.signal,
        result.signal === null
          ? "Detached process exited before producing a result"
          : "Detached process terminated by " + result.signal
      );
    }
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
})().catch(async (error) => {
  await failure(null, null, "Detached supervisor failed: " + (
    error instanceof Error ? error.message : String(error)
  ));
});
`;

export class NodeDetachedProcessLauncher implements DetachedProcessLauncher {
  public readonly launch = async (
    input: DetachedProcessInput
  ): Promise<{ pid: number }> => {
    await Promise.all([
      mkdir(dirname(input.stdoutPath), { recursive: true }),
      mkdir(dirname(input.stderrPath), { recursive: true })
    ]);
    const stdout = await open(input.stdoutPath, "wx");
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    try {
      stderr = await open(input.stderrPath, "wx");
      await Promise.all([stdout.close(), stderr.close()]);
      stderr = undefined;
      const child = spawn(process.execPath, [
        "-e",
        DETACHED_SUPERVISOR,
        JSON.stringify(input)
      ], {
        cwd: input.cwd,
        detached: true,
        shell: false,
        stdio: "ignore"
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (child.pid === undefined) {
        throw new Error("Detached generation process did not expose a PID");
      }
      child.unref();
      return { pid: child.pid };
    } finally {
      await Promise.all([
        stdout.close().catch(() => undefined),
        ...(stderr === undefined ? [] : [stderr.close()])
      ]);
    }
  };
}
