import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeDetachedProcessLauncher
} from "../../../src/adapters/process/node-detached-process-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

async function waitFor(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = await readFile(path, "utf8");
      if (content.length > 0) return content;
    } catch {
      // The detached child may not have created or populated the file yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Detached output was not produced: ${path}`);
}

describe("NodeDetachedProcessLauncher", () => {
  it("returns after spawn and redirects detached output", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-detached-"));
    roots.push(root);
    const stdoutPath = join(root, "job", "stdout.log");
    const stderrPath = join(root, "job", "stderr.log");

    const launched = await new NodeDetachedProcessLauncher().launch({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('done');process.stderr.write('progress')"
      ],
      cwd: root,
      stdoutPath,
      stderrPath
    });

    expect(launched.pid).toBeGreaterThan(0);
    await expect(waitFor(stdoutPath)).resolves.toBe("done");
    await expect(waitFor(stderrPath)).resolves.toBe("progress");
  });

  it("refuses to append another job to existing output files", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-detached-"));
    roots.push(root);
    const input = {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('first')"],
      cwd: root,
      stdoutPath: join(root, "job", "stdout.log"),
      stderrPath: join(root, "job", "stderr.log")
    };
    const launcher = new NodeDetachedProcessLauncher();

    await launcher.launch(input);
    await expect(waitFor(input.stdoutPath)).resolves.toBe("first");
    await expect(launcher.launch(input)).rejects.toMatchObject({
      code: "EEXIST"
    });
  });
});
