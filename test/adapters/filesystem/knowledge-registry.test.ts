import {
  mkdir,
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

async function writeDocument(
  root: string,
  kind: "anchors" | "screens",
  name: string,
  value: unknown
): Promise<string> {
  const directory = join(root, ".taphound", "knowledge", kind);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("FileSystemKnowledgeRegistry", () => {
  it("indexes authored documents, hashes them, and reloads the Registry", async () => {
    const root = await projectRoot();
    await writeDocument(root, "anchors", "home-activity.json", anchor);
    await writeDocument(root, "screens", "home.json", screen);
    const registry = new FileSystemKnowledgeRegistry();

    const rehashed = await registry.rehash(root, "com.example.app");
    const loaded = await registry.load(root);

    expect(rehashed).toMatchObject({
      indexPath: ".taphound/knowledge/index.json",
      revision: 1,
      changed: true,
      anchors: 1,
      screens: 1
    });
    expect(loaded.knowledgeHash).toBe(rehashed.knowledgeHash);
    expect(loaded.anchors).toEqual([anchor]);
    expect(loaded.screens).toEqual([screen]);
  });

  it("keeps the revision for an unchanged rehash and bumps it after an edit", async () => {
    const root = await projectRoot();
    const anchorPath = await writeDocument(
      root,
      "anchors",
      "home-activity.json",
      anchor
    );
    await writeDocument(root, "screens", "home.json", screen);
    const registry = new FileSystemKnowledgeRegistry();
    const first = await registry.rehash(root, "com.example.app");

    await expect(registry.rehash(root, "com.example.app")).resolves
      .toMatchObject({ revision: 1, changed: false, knowledgeHash: first.knowledgeHash });

    await writeFile(anchorPath, `${await readFile(anchorPath, "utf8")}\n`);
    await expect(registry.load(root)).rejects.toThrow(/stale/);
    const second = await registry.rehash(root, "com.example.app");
    expect(second).toMatchObject({ revision: 2, changed: true });
    expect(second.knowledgeHash).not.toBe(first.knowledgeHash);
    await expect(registry.load(root)).resolves.toMatchObject({
      knowledgeHash: second.knowledgeHash
    });
  });

  it("rejects unresolved cross-references, misnamed documents, and package changes", async () => {
    const root = await projectRoot();
    const registry = new FileSystemKnowledgeRegistry();
    await writeDocument(root, "screens", "home.json", screen);
    await expect(registry.rehash(root, "com.example.app"))
      .rejects.toThrow(/unknown Anchor/);

    await writeDocument(root, "anchors", "wrong-name.json", anchor);
    await expect(registry.rehash(root, "com.example.app"))
      .rejects.toThrow(/must be named home-activity\.json/);

    await rm(join(root, ".taphound/knowledge/anchors/wrong-name.json"));
    await writeDocument(root, "anchors", "home-activity.json", anchor);
    await registry.rehash(root, "com.example.app");
    await expect(registry.rehash(root, "com.example.other"))
      .rejects.toThrow(/does not match configured package/);
  });
});
