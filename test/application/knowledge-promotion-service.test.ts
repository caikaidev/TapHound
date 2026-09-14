import { describe, expect, it, vi } from "vitest";

import { KnowledgePromotionService } from "../../src/application/knowledge/promotion-service.js";
import type { KnowledgePromotion } from "../../src/domain/knowledge-receipt.js";
import type { LoadedKnowledgeBundle } from "../../src/ports/knowledge-registry.js";
import type { KnowledgeReceiptStore } from "../../src/ports/knowledge-receipt-store.js";

const HASH = "a".repeat(64);
const SNAPSHOT_HASH = "b".repeat(64);
const anchor = {
  version: 1 as const,
  id: "search-field",
  status: "observed" as const,
  roles: ["screenIdentity" as const],
  identity: {
    kind: "element" as const,
    locator: { resourceId: "com.example.app:id/search" }
  }
};
const screen = {
  version: 1 as const,
  id: "search",
  status: "observed" as const,
  requiredAnchors: ["search-field"],
  optionalAnchors: [],
  forbiddenAnchors: [],
  predicates: []
};
const transition = {
  version: 1 as const,
  id: "open-search",
  status: "observed" as const,
  fromScreen: "home",
  toScreen: "search",
  semantic: "search.open",
  action: { action: "back" as const },
  verification: { targetScreen: "search", timeoutMs: 5_000 },
  observations: { attempts: 1, successes: 1, recoveryCost: 0 }
};
const bundle: LoadedKnowledgeBundle = {
  index: {
    version: 1,
    packageName: "com.example.app",
    revision: 1,
    anchors: [],
    screens: [{
      id: "search",
      path: ".taphound/knowledge/screens/search.json",
      sha256: "c".repeat(64),
      status: "observed"
    }],
    transitions: []
  },
  indexSha256: "d".repeat(64),
  knowledgeHash: HASH,
  anchors: [anchor],
  screens: [screen],
  transitions: [transition]
};
const promotion: KnowledgePromotion = {
  version: 1,
  expectedKnowledgeHash: HASH,
  reason: "verified runtime evidence",
  receiptIds: ["screen-receipt", "transition-receipt"],
  anchors: [{ ...anchor, status: "verified" }],
  screens: [{ ...screen, status: "verified" }],
  transitions: [{ ...transition, status: "verified" }]
};

function receiptStore(
  transitionActualScreen = "search",
  receiptKnowledgeHash = HASH
): Pick<KnowledgeReceiptStore, "read"> {
  return {
    read: ({ receiptId }) => Promise.resolve(
      receiptId === "screen-receipt"
        ? {
            version: 1,
            id: receiptId,
            kind: "screenDetection",
            recordedAt: "2026-09-12T00:00:00.000Z",
            knowledgeHash: receiptKnowledgeHash,
            snapshotHash: SNAPSHOT_HASH,
            result: {
              status: "matched",
              screenId: "search",
              evidence: [{ anchorId: "search-field", result: "matched" }]
            }
          }
        : {
            version: 1,
            id: receiptId,
            kind: "transitionVerification",
            recordedAt: "2026-09-12T00:00:01.000Z",
            knowledgeHash: receiptKnowledgeHash,
            snapshotHash: SNAPSHOT_HASH,
            transitionId: "open-search",
            expectedScreen: "search",
            actualScreen: transitionActualScreen,
            result: "verified"
          }
    )
  };
}

describe("KnowledgePromotionService", () => {
  it("promotes entities only when supplied receipts authorize each upgrade", async () => {
    const writePromoted = vi.fn(() => Promise.resolve({
      indexPath: ".taphound/knowledge/index.json",
      knowledgeHash: "e".repeat(64),
      revision: 2
    }));
    const service = new KnowledgePromotionService({
      registry: {
        load: (): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle),
        writePromoted
      },
      receipts: receiptStore()
    });

    await expect(service.promote({
      projectRoot: "/project",
      packageName: "com.example.app",
      promotion
    })).resolves.toMatchObject({ revision: 2 });
    expect(writePromoted).toHaveBeenCalledOnce();
  });

  it("rejects a verified entity when receipts do not prove that entity", async () => {
    const writePromoted = vi.fn();
    const service = new KnowledgePromotionService({
      registry: {
        load: (): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle),
        writePromoted
      },
      receipts: receiptStore("home")
    });

    await expect(service.promote({
      projectRoot: "/project",
      packageName: "com.example.app",
      promotion
    })).rejects.toThrow("Transition open-search is not authorized");
    expect(writePromoted).not.toHaveBeenCalled();
  });

  it("rejects promotion when the Knowledge hash drifted", async () => {
    const writePromoted = vi.fn();
    const readReceipt = vi.fn(receiptStore().read);
    const service = new KnowledgePromotionService({
      registry: {
        load: (): Promise<LoadedKnowledgeBundle> => Promise.resolve({
          ...bundle,
          knowledgeHash: "f".repeat(64)
        }),
        writePromoted
      },
      receipts: { read: readReceipt }
    });

    await expect(service.promote({
      projectRoot: "/project",
      packageName: "com.example.app",
      promotion
    })).rejects.toThrow("Knowledge changed after the promotion proposal was created");
    expect(readReceipt).not.toHaveBeenCalled();
    expect(writePromoted).not.toHaveBeenCalled();
  });

  it("rejects a receipt bound to a different Knowledge hash", async () => {
    const writePromoted = vi.fn();
    const service = new KnowledgePromotionService({
      registry: {
        load: (): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle),
        writePromoted
      },
      receipts: receiptStore("search", "f".repeat(64))
    });

    await expect(service.promote({
      projectRoot: "/project",
      packageName: "com.example.app",
      promotion
    })).rejects.toThrow(
      "Receipt screen-receipt is not bound to the promoted Knowledge version"
    );
    expect(writePromoted).not.toHaveBeenCalled();
  });

  it("rejects duplicate receipt ids before reading any receipt", async () => {
    const writePromoted = vi.fn();
    const loadRegistry = vi.fn(
      (): Promise<LoadedKnowledgeBundle> => Promise.resolve(bundle)
    );
    const readReceipt = vi.fn(receiptStore().read);
    const service = new KnowledgePromotionService({
      registry: { load: loadRegistry, writePromoted },
      receipts: { read: readReceipt }
    });

    await expect(service.promote({
      projectRoot: "/project",
      packageName: "com.example.app",
      promotion: {
        ...promotion,
        receiptIds: ["screen-receipt", "screen-receipt"]
      }
    })).rejects.toThrow("Promotion receipt ids must be unique");
    expect(loadRegistry).not.toHaveBeenCalled();
    expect(readReceipt).not.toHaveBeenCalled();
    expect(writePromoted).not.toHaveBeenCalled();
  });
});
