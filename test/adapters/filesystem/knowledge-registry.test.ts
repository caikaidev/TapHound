import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemKnowledgeRegistry
} from "../../../src/adapters/filesystem/knowledge-registry.js";

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-knowledge-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

const anchor = {
  version: 1 as const,
  id: "home-activity",
  status: "inferred" as const,
  roles: ["screenIdentity" as const],
  identity: {
    kind: "activity" as const,
    activity: "com.example.app.MainActivity"
  }
};

const screen = {
  version: 1 as const,
  id: "home",
  status: "inferred" as const,
  requiredAnchors: ["home-activity"],
  optionalAnchors: [],
  forbiddenAnchors: [],
  predicates: []
};

describe("FileSystemKnowledgeRegistry", () => {
  it("writes, hashes, and reloads a committed Registry", async () => {
    const root = await projectRoot();
    const registry = new FileSystemKnowledgeRegistry();

    const written = await registry.writePromoted({
      projectRoot: root,
      packageName: "com.example.app",
      anchors: [anchor],
      screens: [screen],
      transitions: []
    });
    const loaded = await registry.load(root);

    expect(written).toMatchObject({
      indexPath: ".taphound/knowledge/index.json",
      revision: 1
    });
    expect(loaded.knowledgeHash).toBe(written.knowledgeHash);
    expect(loaded.screens).toEqual([screen]);
  });

  it("detects document drift and rejects stale promotion", async () => {
    const root = await projectRoot();
    const registry = new FileSystemKnowledgeRegistry();
    const written = await registry.writePromoted({
      projectRoot: root,
      packageName: "com.example.app",
      anchors: [anchor],
      screens: [screen],
      transitions: []
    });
    const anchorPath = join(
      root,
      ".taphound/knowledge/anchors/home-activity.json"
    );
    const bytes = await readFile(anchorPath, "utf8");
    await writeFile(anchorPath, `${bytes}\n`);

    await expect(registry.load(root)).rejects.toThrow(/stale/);
    await expect(registry.writePromoted({
      projectRoot: root,
      packageName: "com.example.app",
      expectedKnowledgeHash: written.knowledgeHash,
      anchors: [anchor],
      screens: [screen],
      transitions: []
    })).rejects.toThrow(/stale/);
  });

  it("rejects unresolved cross-references before writing", async () => {
    const root = await projectRoot();
    await expect(new FileSystemKnowledgeRegistry().writePromoted({
      projectRoot: root,
      packageName: "com.example.app",
      anchors: [],
      screens: [screen],
      transitions: []
    })).rejects.toThrow(/unknown Anchor/);
  });
});
