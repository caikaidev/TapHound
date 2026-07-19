import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemArtifactStore } from "../../../src/adapters/filesystem/artifact-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apr-artifacts-test-"));
  roots.push(root);
  return root;
}

describe("FileSystemArtifactStore", () => {
  it("writes nested artifacts and atomically publishes the run directory", async () => {
    const root = await temporaryRoot();
    const store = new FileSystemArtifactStore();
    const session = await store.begin(root, "run-123");

    await session.writeText("logcat.txt", "all logs\n");
    await session.writeJson("steps/001-layout-diff.json", [{ changed: "text" }]);
    const finalDirectory = await session.publish();

    expect(finalDirectory).toBe(join(root, "run-123"));
    await expect(readFile(join(finalDirectory, "logcat.txt"), "utf8"))
      .resolves.toBe("all logs\n");
    const diffStats = await stat(
      join(finalDirectory, "steps/001-layout-diff.json")
    );
    expect(diffStats.isFile()).toBe(true);
    expect((await readdir(root)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
  });

  it("provides a safe temporary path for external collectors", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-123");

    expect(session.path("steps/001.png")).toContain("steps/001.png");
    expect(() => session.path("../escape.txt")).toThrow(/artifact path/i);
    await session.discard();
  });

  it("discards an unpublished temporary directory", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-123");
    await session.writeText("partial.txt", "partial");

    await session.discard();

    expect(await readdir(root)).toEqual([]);
  });
});
