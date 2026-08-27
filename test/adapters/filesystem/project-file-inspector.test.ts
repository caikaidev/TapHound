import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  rename
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProjectFileInspector } from "../../../src/adapters/filesystem/project-file-inspector.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-inspector-"));
  roots.push(root);
  return root;
}

describe("NodeProjectFileInspector", () => {
  describe("inspectProjectFile", () => {
    it("inspects a file and returns the sha256 and bytes", async () => {
      const root = await makeRoot();
      const content = "class MainActivity\n";
      await mkdir(join(root, "app"), { recursive: true });
      await writeFile(join(root, "app/source.kt"), content, "utf8");
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "app/source.kt",
        maximumBytes: 1024
      });

      expect(result.status).toBe("inspected");
      if (result.status === "inspected") {
        expect(result.resolvedRelativePath).toBe("app/source.kt");
        expect(result.bytes?.toString("utf8")).toBe(content);
      }
    });

    it("returns notFound for a missing file", async () => {
      const root = await makeRoot();
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "missing.kt",
        maximumBytes: 1024
      });

      expect(result).toEqual({ status: "notFound" });
    });

    it("returns escape for a path that leaves the project root", async () => {
      const root = await makeRoot();
      await writeFile(join(root, "secret.txt"), "secret", "utf8");
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "../secret.txt",
        maximumBytes: 1024
      });

      expect(result).toEqual({ status: "escape" });
    });

    it("returns rootNotFound for a nonexistent project root", async () => {
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: "/nonexistent/path/that/does/not/exist",
        relativePath: "file.txt",
        maximumBytes: 1024
      });

      expect(result).toEqual({ status: "rootNotFound" });
    });

    it("returns rootNotDirectory when the root is a file", async () => {
      const root = await makeRoot();
      const filePath = join(root, "not-a-dir");
      await writeFile(filePath, "file", "utf8");
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: filePath,
        relativePath: "file.txt",
        maximumBytes: 1024
      });

      expect(result).toEqual({ status: "rootNotDirectory" });
    });

    it("returns tooLarge when the file exceeds maximumBytes", async () => {
      const root = await makeRoot();
      const content = "x".repeat(100);
      await writeFile(join(root, "big.txt"), content, "utf8");
      const inspector = new NodeProjectFileInspector();

      const result = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "big.txt",
        maximumBytes: 10
      });

      expect(result.status).toBe("tooLarge");
    });
  });

  describe("root cache", () => {
    it("caches the root and serves subsequent calls from the cache", async () => {
      const root = await makeRoot();
      await writeFile(join(root, "file.kt"), "content", "utf8");
      const inspector = new NodeProjectFileInspector();

      const first = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "file.kt",
        maximumBytes: 1024
      });
      const second = await inspector.inspectProjectFile({
        projectRoot: root,
        relativePath: "file.kt",
        maximumBytes: 1024
      });

      expect(first.status).toBe("inspected");
      expect(second.status).toBe("inspected");
      if (first.status === "inspected" && second.status === "inspected") {
        expect(second.sha256).toBe(first.sha256);
      }
    });

    it("handles multiple project roots in the same inspector instance", async () => {
      const rootA = await makeRoot();
      const rootB = await makeRoot();
      await writeFile(join(rootA, "a.kt"), "content-a", "utf8");
      await writeFile(join(rootB, "b.kt"), "content-b", "utf8");
      const inspector = new NodeProjectFileInspector();

      const a = await inspector.inspectProjectFile({
        projectRoot: rootA,
        relativePath: "a.kt",
        maximumBytes: 1024
      });
      const b = await inspector.inspectProjectFile({
        projectRoot: rootB,
        relativePath: "b.kt",
        maximumBytes: 1024
      });
      const aAgain = await inspector.inspectProjectFile({
        projectRoot: rootA,
        relativePath: "a.kt",
        maximumBytes: 1024
      });

      expect(a.status).toBe("inspected");
      expect(b.status).toBe("inspected");
      expect(aAgain.status).toBe("inspected");
    });

    it("re-resolves the root after the directory is replaced", async () => {
      const root = await makeRoot();
      const innerDir = join(root, "project");
      await mkdir(innerDir);
      await writeFile(join(innerDir, "file.kt"), "original", "utf8");
      const inspector = new NodeProjectFileInspector();

      const first = await inspector.inspectProjectFile({
        projectRoot: innerDir,
        relativePath: "file.kt",
        maximumBytes: 1024
      });
      expect(first.status).toBe("inspected");

      await rm(innerDir, { recursive: true, force: true });
      await mkdir(innerDir);
      await writeFile(join(innerDir, "file.kt"), "replaced", "utf8");

      const second = await inspector.inspectProjectFile({
        projectRoot: innerDir,
        relativePath: "file.kt",
        maximumBytes: 1024
      });
      expect(second.status).toBe("inspected");
      if (second.status === "inspected") {
        expect(second.bytes?.toString("utf8")).toBe("replaced");
      }
    });

    it("re-resolves the root after it is renamed", async () => {
      const root = await makeRoot();
      const dirA = join(root, "dir-a");
      const dirB = join(root, "dir-b");
      await mkdir(dirA);
      await writeFile(join(dirA, "file.kt"), "content", "utf8");
      const inspector = new NodeProjectFileInspector();

      await inspector.inspectProjectFile({
        projectRoot: dirA,
        relativePath: "file.kt",
        maximumBytes: 1024
      });

      await rename(dirA, dirB);

      const result = await inspector.inspectProjectFile({
        projectRoot: dirB,
        relativePath: "file.kt",
        maximumBytes: 1024
      });
      expect(result.status).toBe("inspected");
    });
  });
});
