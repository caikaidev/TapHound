import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemContextDocumentWriter } from "../../../src/adapters/filesystem/context-document-writer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-writer-"));
  roots.push(root);
  return root;
}

describe("FileSystemContextDocumentWriter", () => {
  describe("writeContextDocument", () => {
    it("writes a document atomically and returns the sha256", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();
      const document = { version: 2, modules: [] };

      const result = await writer.writeContextDocument({
        projectRoot: root,
        relativePath: ".taphound/context/project-context.json",
        document
      });

      expect(result).toEqual({
        status: "written",
        sha256: sha256(`${JSON.stringify(document, null, 2)}\n`)
      });

      const written = JSON.parse(
        await readFile(join(root, ".taphound/context/project-context.json"), "utf8")
      ) as unknown;
      expect(written).toEqual(document);
    });

    it("rejects paths that escape the project root", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();

      const result = await writer.writeContextDocument({
        projectRoot: root,
        relativePath: "../../../etc/passwd",
        document: {}
      });

      expect(result).toEqual({ status: "escape" });
    });

    it("returns unwritable when the project root does not exist", async () => {
      const writer = new FileSystemContextDocumentWriter();

      const result = await writer.writeContextDocument({
        projectRoot: "/nonexistent/path/that/does/not/exist",
        relativePath: "test.json",
        document: {}
      });

      expect(result.status).toBe("unwritable");
    });
  });

  describe("writeContextDocumentBatch", () => {
    it("writes all documents and returns per-document sha256", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();
      const indexDoc = { version: 2, modules: [] };
      const shardDoc = { version: 2, moduleId: ":app" };

      const results = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: [
          {
            relativePath: ".taphound/context/modules/app.json",
            document: shardDoc
          },
          {
            relativePath: ".taphound/context/project-context.json",
            document: indexDoc
          }
        ]
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        status: "written",
        sha256: sha256(`${JSON.stringify(shardDoc, null, 2)}\n`)
      });
      expect(results[1]).toEqual({
        status: "written",
        sha256: sha256(`${JSON.stringify(indexDoc, null, 2)}\n`)
      });

      const shard = JSON.parse(
        await readFile(join(root, ".taphound/context/modules/app.json"), "utf8")
      ) as unknown;
      const index = JSON.parse(
        await readFile(join(root, ".taphound/context/project-context.json"), "utf8")
      ) as unknown;
      expect(shard).toEqual(shardDoc);
      expect(index).toEqual(indexDoc);
    });

    it("returns an empty array for an empty document list", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();

      const results = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: []
      });

      expect(results).toEqual([]);
    });

    it("returns escape for all documents when one path escapes", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();

      const results = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: [
          { relativePath: "valid.json", document: { a: 1 } },
          { relativePath: "../../../etc/passwd", document: { b: 2 } }
        ]
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "escape")).toBe(true);

      const entries = await readdir(root);
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("cleans up temporary files on write failure", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();

      await writeFile(join(root, "target.json"), "existing", "utf8");
      await mkdir(join(root, "target.json", "subdir"), { recursive: true }).catch(
        () => undefined
      );

      const results = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: [
          { relativePath: "good.json", document: { ok: true } },
          { relativePath: "target.json/subdir", document: { bad: true } }
        ]
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "unwritable")).toBe(true);

      const entries = await readdir(root);
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("returns unwritable for all documents when root does not exist", async () => {
      const writer = new FileSystemContextDocumentWriter();

      const results = await writer.writeContextDocumentBatch({
        projectRoot: "/nonexistent/path/that/does/not/exist",
        documents: [
          { relativePath: "a.json", document: {} },
          { relativePath: "b.json", document: {} }
        ]
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "unwritable")).toBe(true);
    });

    it("produces the same sha256 as writeContextDocument", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();
      const document = { version: 2, name: "test" };

      const single = await writer.writeContextDocument({
        projectRoot: root,
        relativePath: "single.json",
        document
      });
      const batch = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: [
          { relativePath: "batch.json", document }
        ]
      });

      expect(single.status).toBe("written");
      expect(batch[0]?.status).toBe("written");
      if (single.status === "written" && batch[0]?.status === "written") {
        expect(batch[0].sha256).toBe(single.sha256);
      }
    });

    it("writes to nested directories that do not yet exist", async () => {
      const root = await makeRoot();
      const writer = new FileSystemContextDocumentWriter();

      const results = await writer.writeContextDocumentBatch({
        projectRoot: root,
        documents: [
          {
            relativePath: "a/b/c/deep.json",
            document: { deep: true }
          }
        ]
      });

      expect(results[0]?.status).toBe("written");
      const written = JSON.parse(
        await readFile(join(root, "a/b/c/deep.json"), "utf8")
      ) as unknown;
      expect(written).toEqual({ deep: true });
    });
  });
});
