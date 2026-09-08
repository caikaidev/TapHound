import { describe, expect, it, vi } from "vitest";

import type {
  AnchorDefinition,
  ScreenDefinition,
  TransitionDefinition
} from "../../../src/domain/knowledge.js";
import type { KnowledgeReceipt } from "../../../src/domain/knowledge-receipt.js";
import type { LoadedKnowledgeBundle } from "../../../src/ports/knowledge-registry.js";
import { KnowledgeEvolutionService } from "../../../src/application/knowledge/knowledge-evolver.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function anchor(id: string, status: AnchorDefinition["status"]): AnchorDefinition {
  return {
    version: 1,
    id,
    status,
    roles: ["screenIdentity"],
    identity: { kind: "activity", activity: "com.example.MainActivity" }
  };
}

function screen(
  id: string,
  status: ScreenDefinition["status"],
  anchorId: string
): ScreenDefinition {
  return {
    version: 1,
    id,
    status,
    requiredAnchors: [anchorId],
    optionalAnchors: [],
    forbiddenAnchors: [],
    predicates: []
  };
}

function transition(
  id: string,
  status: TransitionDefinition["status"]
): TransitionDefinition {
  return {
    version: 1,
    id,
    status,
    fromScreen: "home",
    toScreen: "home-search",
    semantic: "open-search",
    action: { action: "click", anchorId: "home-anchor" },
    verification: { targetScreen: "home-search", timeoutMs: 5000 },
    observations: { attempts: 0, successes: 0, recoveryCost: 0 }
  };
}

function bundle(input?: {
  anchors?: AnchorDefinition[];
  screens?: ScreenDefinition[];
  transitions?: TransitionDefinition[];
  knowledgeHash?: string;
  revision?: number;
}): LoadedKnowledgeBundle {
  const anchors = input?.anchors ?? [anchor("home-anchor", "inferred")];
  const screens = input?.screens ?? [
    screen("home", "inferred", "home-anchor"),
    screen("home-search", "inferred", "home-anchor")
  ];
  const transitions = input?.transitions ?? [transition("home-to-search", "inferred")];
  const hash = input?.knowledgeHash ?? HASH;
  return {
    index: {
      version: 1,
      packageName: "com.example.app",
      revision: input?.revision ?? 1,
      anchors: anchors.map((document) => ({
        id: document.id,
        path: `.taphound/knowledge/anchors/${document.id}.json`,
        sha256: "1".repeat(64),
        status: document.status
      })),
      screens: screens.map((document) => ({
        id: document.id,
        path: `.taphound/knowledge/screens/${document.id}.json`,
        sha256: "2".repeat(64),
        status: document.status
      })),
      transitions: transitions.map((document) => ({
        id: document.id,
        path: `.taphound/knowledge/transitions/${document.id}.json`,
        sha256: "3".repeat(64),
        status: document.status
      }))
    },
    indexSha256: "c".repeat(64),
    knowledgeHash: hash,
    anchors,
    screens,
    transitions
  };
}

function transitionReceipt(
  id: string,
  transitionId: string,
  result: "verified" | "deviated" | "unknown",
  knowledgeHash = HASH
): KnowledgeReceipt {
  return {
    version: 1,
    id,
    kind: "transitionVerification",
    recordedAt: "2026-01-01T00:00:00.000Z",
    knowledgeHash,
    snapshotHash: "d".repeat(64),
    transitionId,
    expectedScreen: "home-search",
    actualScreen: "home-search",
    result
  };
}

function detectionReceipt(
  id: string,
  screenId: string,
  anchorId: string,
  knowledgeHash = HASH
): KnowledgeReceipt {
  return {
    version: 1,
    id,
    kind: "screenDetection",
    recordedAt: "2026-01-01T00:00:00.000Z",
    knowledgeHash,
    snapshotHash: "d".repeat(64),
    result: {
      status: "matched",
      screenId,
      evidence: [{ anchorId, result: "matched" }]
    }
  };
}

function replanReceipt(id: string, knowledgeHash = HASH): KnowledgeReceipt {
  return {
    version: 1,
    id,
    kind: "replan",
    recordedAt: "2026-01-01T00:00:00.000Z",
    knowledgeHash,
    snapshotHash: "d".repeat(64),
    goalId: "goal",
    previousRouteHash: "e".repeat(64),
    nextRouteHash: "f".repeat(64),
    reason: "transitionDeviation",
    remainingBudget: 1
  };
}

function anchorResolutionReceipt(
  id: string,
  anchorId: string,
  result: "matched" | "missing" | "ambiguous" | "unknown",
  knowledgeHash = HASH
): KnowledgeReceipt {
  return {
    version: 1,
    id,
    kind: "anchorResolution",
    recordedAt: "2026-01-01T00:00:00.000Z",
    knowledgeHash,
    snapshotHash: "d".repeat(64),
    anchorId,
    result
  };
}

function harness(input: {
  bundle: LoadedKnowledgeBundle;
  receipts: readonly KnowledgeReceipt[];
}): {
  evolve: KnowledgeEvolutionService["evolve"];
  writePromoted: ReturnType<typeof vi.fn>;
} {
  const writePromoted = vi.fn(() => Promise.resolve({
    indexPath: ".taphound/knowledge/index.json",
    knowledgeHash: "9".repeat(64),
    revision: input.bundle.index.revision + 1
  }));
  const service = new KnowledgeEvolutionService({
    registry: {
      load: vi.fn(() => Promise.resolve(input.bundle)),
      writePromoted
    },
    receipts: {
      list: vi.fn(() => Promise.resolve(input.receipts))
    }
  });
  return { evolve: service.evolve, writePromoted };
}

describe("KnowledgeEvolutionService", () => {
  it("folds bound transition receipts into observations", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle(),
      receipts: [
        transitionReceipt("r1", "home-to-search", "verified"),
        transitionReceipt("r2", "home-to-search", "verified"),
        transitionReceipt("r3", "home-to-search", "deviated")
      ]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result).toEqual({
      status: "evolved",
      knowledgeHash: "9".repeat(64),
      revision: 2,
      foldedReceipts: 3,
      summary: {
        transitionsUpdated: 1,
        anchorsUpgraded: 0,
        screensUpgraded: 0
      }
    });
    const written = writePromoted.mock.calls[0]?.[0] as {
      expectedKnowledgeHash: string;
      transitions: TransitionDefinition[];
    };
    expect(written.expectedKnowledgeHash).toBe(HASH);
    expect(written.transitions[0]).toEqual({
      version: 1,
      id: "home-to-search",
      status: "observed",
      fromScreen: "home",
      toScreen: "home-search",
      semantic: "open-search",
      action: { action: "click", anchorId: "home-anchor" },
      verification: { targetScreen: "home-search", timeoutMs: 5000 },
      observations: { attempts: 3, successes: 2, recoveryCost: 1 }
    });
  });

  it("upgrades inferred screens and anchors from matched detections", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle(),
      receipts: [detectionReceipt("r1", "home", "home-anchor")]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result.status).toBe("evolved");
    const written = writePromoted.mock.calls[0]?.[0] as {
      anchors: AnchorDefinition[];
      screens: ScreenDefinition[];
    };
    expect(written.anchors[0]?.status).toBe("observed");
    expect(written.screens[0]?.status).toBe("observed");
    expect(written.screens[1]?.status).toBe("inferred");
  });

  it("never downgrades verified or observed documents", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle({
        anchors: [anchor("home-anchor", "verified")],
        screens: [
          screen("home", "verified", "home-anchor"),
          screen("home-search", "observed", "home-anchor")
        ],
        transitions: [transition("home-to-search", "verified")]
      }),
      receipts: [
        detectionReceipt("r1", "home", "home-anchor"),
        transitionReceipt("r2", "home-to-search", "unknown")
      ]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result.status).toBe("evolved");
    const written = writePromoted.mock.calls[0]?.[0] as {
      anchors: AnchorDefinition[];
      screens: ScreenDefinition[];
      transitions: TransitionDefinition[];
    };
    expect(written.anchors[0]?.status).toBe("verified");
    expect(written.screens[0]?.status).toBe("verified");
    expect(written.screens[1]?.status).toBe("observed");
    expect(written.transitions[0]?.status).toBe("verified");
    expect(written.transitions[0]?.observations).toEqual({
      attempts: 1,
      successes: 0,
      recoveryCost: 0
    });
  });

  it("accumulates observations on top of existing counts", async () => {
    const existing = transition("home-to-search", "observed");
    existing.observations = { attempts: 5, successes: 4, recoveryCost: 2 };
    const { evolve, writePromoted } = harness({
      bundle: bundle({ transitions: [existing] }),
      receipts: [transitionReceipt("r1", "home-to-search", "verified")]
    });
    await evolve({ projectRoot: "/project", packageName: "com.example.app" });
    const written = writePromoted.mock.calls[0]?.[0] as {
      transitions: TransitionDefinition[];
    };
    expect(written.transitions[0]?.observations).toEqual({
      attempts: 6,
      successes: 5,
      recoveryCost: 2
    });
  });

  it("ignores receipts bound to another Knowledge hash", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle(),
      receipts: [
        transitionReceipt("r1", "home-to-search", "verified", OTHER_HASH),
        replanReceipt("r2", OTHER_HASH)
      ]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result).toEqual({
      status: "unchanged",
      knowledgeHash: HASH,
      revision: 1,
      foldedReceipts: 0
    });
    expect(writePromoted).not.toHaveBeenCalled();
  });

  it("reports unchanged when eligible receipts mutate nothing", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle(),
      receipts: [replanReceipt("r1")]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result).toEqual({
      status: "unchanged",
      knowledgeHash: HASH,
      revision: 1,
      foldedReceipts: 1
    });
    expect(writePromoted).not.toHaveBeenCalled();
  });

  it("upgrades inferred anchors from matched anchor resolutions", async () => {
    const { evolve, writePromoted } = harness({
      bundle: bundle(),
      receipts: [
        anchorResolutionReceipt("r1", "home-anchor", "matched"),
        anchorResolutionReceipt("r2", "home-anchor", "missing")
      ]
    });
    const result = await evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    });
    expect(result.status).toBe("evolved");
    const written = writePromoted.mock.calls[0]?.[0] as {
      anchors: AnchorDefinition[];
    };
    expect(written.anchors[0]?.status).toBe("observed");
  });

  it("rejects receipts referencing unknown transitions", async () => {
    const { evolve } = harness({
      bundle: bundle(),
      receipts: [transitionReceipt("r1", "missing-transition", "verified")]
    });
    await expect(evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    })).rejects.toThrow(/unknown Transition: missing-transition/);
  });

  it("rejects receipts referencing unknown anchors", async () => {
    const { evolve } = harness({
      bundle: bundle(),
      receipts: [detectionReceipt("r1", "home", "missing-anchor")]
    });
    await expect(evolve({
      projectRoot: "/project",
      packageName: "com.example.app"
    })).rejects.toThrow(/unknown Anchor: missing-anchor/);
  });
});
