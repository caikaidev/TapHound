import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemKnowledgeReceiptStore
} from "../../../src/adapters/filesystem/knowledge-receipt-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("FileSystemKnowledgeReceiptStore", () => {
  it("writes immutable receipts and refuses replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-receipt-"));
    roots.push(root);
    const store = new FileSystemKnowledgeReceiptStore();
    const receipt = {
      version: 1 as const,
      id: "receipt-1",
      kind: "anchorResolution" as const,
      recordedAt: "2026-09-06T00:00:00.000Z",
      knowledgeHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      anchorId: "home",
      result: "matched" as const,
      matchedElementId: "node-1"
    };

    expect(await store.write({ projectRoot: root, receipt })).toBe(
      ".taphound/build/knowledge-receipts/receipt-1.json"
    );
    expect(await store.read({
      projectRoot: root,
      receiptId: "receipt-1"
    })).toEqual(receipt);
    await expect(store.write({ projectRoot: root, receipt })).rejects.toThrow(
      /already exists/
    );
  });
});
