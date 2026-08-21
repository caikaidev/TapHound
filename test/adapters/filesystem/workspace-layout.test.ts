import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemWorkspaceLayout
} from "../../../src/adapters/filesystem/workspace-layout.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
  roots.push(root);
  return root;
}

describe("FileSystemWorkspaceLayout", () => {
  it("reports no legacy directories for a fresh or current workspace", async () => {
    const root = await temporaryRoot();
    const layout = new FileSystemWorkspaceLayout();

    await expect(layout.findLegacyDirectories(root)).resolves.toEqual([]);

    await mkdir(join(root, ".taphound", "build", "generations"), {
      recursive: true
    });
    await mkdir(join(root, ".taphound", "journeys"));

    await expect(layout.findLegacyDirectories(root)).resolves.toEqual([]);
  });

  it("reports every legacy directory in a stable order", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const layout = new FileSystemWorkspaceLayout();
    await mkdir(join(root, ".taphound", "runs"), { recursive: true });
    await mkdir(join(root, ".taphound", "generations"));
    await symlink(outside, join(root, ".taphound", "jobs"));

    await expect(layout.findLegacyDirectories(root)).resolves.toEqual([
      ".taphound/generations",
      ".taphound/jobs",
      ".taphound/runs"
    ]);
  });

  it("creates the build ignore file exactly once", async () => {
    const root = await temporaryRoot();
    const layout = new FileSystemWorkspaceLayout();
    await mkdir(join(root, ".taphound"));

    await layout.ensureBuildIgnored(root);

    const ignorePath = join(root, ".taphound", ".gitignore");
    await expect(readFile(ignorePath, "utf8")).resolves.toBe("build/\n");

    await writeFile(ignorePath, "build/\n!keep\n", "utf8");
    await layout.ensureBuildIgnored(root);

    await expect(readFile(ignorePath, "utf8")).resolves.toBe("build/\n!keep\n");
  });

  it("never writes through an ignore-file symlink", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const layout = new FileSystemWorkspaceLayout();
    const victim = join(outside, "victim");
    await writeFile(victim, "unchanged", "utf8");
    await mkdir(join(root, ".taphound"));
    await symlink(victim, join(root, ".taphound", ".gitignore"));

    await layout.ensureBuildIgnored(root);

    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
  });
});
