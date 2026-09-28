import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemDiagnosticsJournal } from "../../../src/adapters/filesystem/diagnostics-journal.js";
import type { CommandEvent } from "../../../src/domain/diagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(options: { buildLayout: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-journal-"));
  roots.push(root);
  await mkdir(join(root, ".taphound"));
  if (options.buildLayout) {
    await mkdir(join(root, ".taphound", "build"));
    await writeFile(join(root, ".taphound", ".gitignore"), "build/\n");
  }
  return root;
}

function event(exitCode: number): CommandEvent {
  return {
    version: 1,
    kind: "command",
    at: "2026-09-28T12:00:00.000Z",
    taphoundVersion: "0.2.0-dev.11",
    host: { platform: "darwin", arch: "arm64", node: "24.3.0" },
    command: "verify",
    flags: ["json"],
    durationMs: 10,
    exitCode,
    ui: []
  };
}

function exitCodes(lines: readonly string[]): number[] {
  return lines.map((line) => (JSON.parse(line) as CommandEvent).exitCode);
}

describe("FileSystemDiagnosticsJournal", () => {
  it("appends events to an initialized build layout", async () => {
    const root = await project({ buildLayout: true });
    const journal = new FileSystemDiagnosticsJournal();

    await journal.append(root, event(0));
    await journal.append(root, event(1));

    expect(exitCodes(await journal.readLines(root))).toEqual([0, 1]);
  });

  it("never creates the build layout for read-only commands", async () => {
    const root = await project({ buildLayout: false });

    await new FileSystemDiagnosticsJournal().append(root, event(0));

    await expect(access(join(root, ".taphound", "build"))).rejects.toThrow();
    await expect(access(join(root, ".taphound", ".gitignore"))).rejects.toThrow();
  });

  it("rotates to one predecessor when the current file would exceed its cap", async () => {
    const root = await project({ buildLayout: true });
    const lineBytes = Buffer.byteLength(`${JSON.stringify(event(0))}\n`);
    const journal = new FileSystemDiagnosticsJournal(lineBytes * 2);

    for (const code of [0, 1, 2, 3, 4]) {
      await journal.append(root, event(code));
    }

    const log = join(root, ".taphound", "build", "log");
    expect((await readFile(join(log, "events.1.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readFile(join(log, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect(exitCodes(await journal.readLines(root))).toEqual([2, 3, 4]);
  });

  it("keeps one local salt and refuses directories that are not TapHound projects", async () => {
    const root = await project({ buildLayout: false });
    const journal = new FileSystemDiagnosticsJournal();

    const first = await journal.salt(root);
    const second = await journal.salt(root);

    expect(first.length).toBe(32);
    expect(second.equals(first)).toBe(true);
    await expect(access(join(root, ".taphound", ".gitignore"))).resolves.toBeUndefined();

    const outside = await mkdtemp(join(tmpdir(), "taphound-journal-outside-"));
    roots.push(outside);
    await expect(journal.salt(outside)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(access(join(outside, ".taphound"))).rejects.toThrow();
  });
});
