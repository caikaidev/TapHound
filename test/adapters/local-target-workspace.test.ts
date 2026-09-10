import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemLocalTargetWorkspace } from "../../src/adapters/filesystem/local-target-workspace.js";
import type { LocalTargetIdentity } from "../../src/domain/target.js";

let home: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("FileSystemLocalTargetWorkspace", () => {
  it("writes and reads identity.json atomically", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    const identity: LocalTargetIdentity = {
      schemaVersion: 1,
      targetId: "app",
      sourceType: "local",
      configuredPath: "${X}",
      resolvedPath: "/real/app",
      fingerprint: {
        schemaVersion: 1,
        hash: "a".repeat(64)
      },
      packageName: "com.example.app",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    };
    await workspace.ensureWorkspace(home, "app");
    await workspace.writeIdentity(home, "app", identity);
    const loaded = await workspace.readIdentity(home, "app");
    expect(loaded?.targetId).toBe("app");
    expect(loaded?.fingerprint.hash).toBe("a".repeat(64));
  });

  it("returns null when no identity exists", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    await expect(workspace.readIdentity(home, "app")).resolves.toBeNull();
  });

  it("creates .taphound/.gitignore with local/ and never overwrites", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    const workspace = new FileSystemLocalTargetWorkspace();
    await workspace.ensureWorkspace(home, "app");
    const gitignore = await readFile(join(home, ".taphound", ".gitignore"), "utf8");
    expect(gitignore).toContain("local/");
  });

  it("appends local/ to an existing project .gitignore without duplicating", async () => {
    home = await mkdtemp(join(tmpdir(), "taphound-workspace-"));
    await mkdir(join(home, ".taphound"), { recursive: true });
    await writeFile(join(home, ".taphound", ".gitignore"), "build/", "utf8");
    const workspace = new FileSystemLocalTargetWorkspace();
    await workspace.ensureWorkspace(home, "app");
    const first = await readFile(join(home, ".taphound", ".gitignore"), "utf8");
    expect(first).toContain("build/");
    expect(first).toContain("local/");
    await workspace.ensureWorkspace(home, "app");
    const second = await readFile(join(home, ".taphound", ".gitignore"), "utf8");
    expect(second).toBe(first);
    expect(second.match(/local\/\n/g)).toHaveLength(1);
  });
});