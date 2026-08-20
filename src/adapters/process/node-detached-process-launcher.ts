import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  DetachedProcessInput,
  DetachedProcessLauncher
} from "../../ports/detached-process-launcher.js";

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
      const child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", stdout.fd, stderr.fd]
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
        stdout.close(),
        ...(stderr === undefined ? [] : [stderr.close()])
      ]);
    }
  };
}
