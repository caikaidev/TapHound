import { describe, expect, it } from "vitest";

import {
  GenerationPlanner
} from "../../../src/application/generation/generation-planner.js";
import {
  KnowledgeLoader
} from "../../../src/application/knowledge/knowledge-loader.js";
import {
  KnowledgeReceiptRecorder
} from "../../../src/application/knowledge/receipt-recorder.js";
import type { GenerationSession } from "../../../src/domain/generation.js";
import type { RuntimeSnapshot } from "../../../src/domain/runtime-snapshot.js";
import { hashGoalSpec } from "../../../src/domain/route.js";
import type {
  LoadedKnowledgeBundle
} from "../../../src/ports/knowledge-registry.js";

const knowledgeHash = "a".repeat(64);

const knowledge: LoadedKnowledgeBundle = {
  index: {
    version: 1,
    packageName: "com.example.app",
    revision: 1,
    anchors: [],
    screens: [{
      id: "home",
      path: ".taphound/knowledge/screens/home.json",
      sha256: "1".repeat(64),
      status: "verified"
    }],
    transitions: []
  },
  indexSha256: "b".repeat(64),
  knowledgeHash,
  anchors: [
    {
      version: 1,
      id: "home-activity",
      status: "verified",
      roles: ["screenIdentity"],
      identity: {
        kind: "activity",
        activity: "com.example.app.MainActivity"
      }
    },
    {
      version: 1,
      id: "permission-activity",
      status: "verified",
      roles: ["screenIdentity"],
      identity: {
        kind: "activity",
        activity: "com.example.app.PermissionActivity"
      }
    },
    {
      version: 1,
      id: "detail-activity",
      status: "verified",
      roles: ["screenIdentity"],
      identity: {
        kind: "activity",
        activity: "com.example.app.DetailActivity"
      }
    }
  ],
  screens: [
    {
      version: 1,
      id: "home",
      status: "verified",
      requiredAnchors: ["home-activity"],
      optionalAnchors: [],
      forbiddenAnchors: [],
      predicates: []
    },
    {
      version: 1,
      id: "permission",
      status: "verified",
      requiredAnchors: ["permission-activity"],
      optionalAnchors: [],
      forbiddenAnchors: [],
      predicates: []
    },
    {
      version: 1,
      id: "detail",
      status: "verified",
      requiredAnchors: ["detail-activity"],
      optionalAnchors: [],
      forbiddenAnchors: [],
      predicates: []
    }
  ],
  transitions: [
    {
      version: 1,
      id: "open-detail",
      status: "verified",
      fromScreen: "home",
      toScreen: "detail",
      semantic: "open-detail",
      action: { action: "wait" },
      verification: { targetScreen: "detail", timeoutMs: 1000 },
      observations: { attempts: 1, successes: 1, recoveryCost: 0 }
    },
    {
      version: 1,
      id: "permission-to-detail",
      status: "verified",
      fromScreen: "permission",
      toScreen: "detail",
      semantic: "allow",
      action: { action: "wait" },
      verification: { targetScreen: "detail", timeoutMs: 1000 },
      observations: { attempts: 1, successes: 1, recoveryCost: 0 }
    }
  ]
};

function session(): GenerationSession {
  const goal = {
    version: 1 as const,
    id: "open-detail",
    targetScreen: "detail",
    parameters: {},
    limits: { maxSteps: 5, maxReplans: 1 }
  };
  return {
    version: 2,
    id: "generation-1",
    revision: 1,
    state: "active",
    bindings: {
      projectHash: "1".repeat(64),
      configHash: "2".repeat(64),
      contextHash: "3".repeat(64),
      snapshotHash: "4".repeat(64)
    },
    target: {
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      resetStrategy: "processOnly",
      interactionPolicy: {
        allowedActions: ["wait"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      }
    },
    contextSelection: {
      bundleVersion: 2,
      indexHash: "5".repeat(64),
      modules: [{
        id: ":app",
        sha256: "6".repeat(64),
        projectDir: "app",
        inventory: {
          pathSetSha256: "7".repeat(64),
          categories: ["sources"]
        }
      }]
    },
    variables: {
      runId: "run-1",
      timestamp: "2026-09-06T00:00:00.000Z",
      randomHex: "00"
    },
    externalFlows: [],
    candidateSteps: [],
    candidateSources: [],
    inFlight: null,
    pendingConfirmation: null,
    verification: { status: "notRun" },
    publication: { status: "notRun" },
    planning: {
      knowledgeHash,
      goalHash: hashGoalSpec(goal),
      goal,
      currentScreen: null,
      currentRoute: null,
      replansUsed: 0,
      maxReplans: 1,
      maxSteps: 5
    }
  };
}

function snapshot(
  activity = "com.example.app.MainActivity"
): RuntimeSnapshot {
  return {
    version: 1,
    generationId: "generation-1",
    baseRevision: 1,
    deviceSerial: "emulator-5554",
    expectedPackageName: "com.example.app",
    foregroundPackageName: "com.example.app",
    activity,
    pid: 42,
    capturedAt: "2026-09-06T00:00:00.000Z",
    layout: []
  };
}

function planner(receipts: { kind: string }[]): GenerationPlanner {
  const loader = new KnowledgeLoader({
    load: (): Promise<LoadedKnowledgeBundle> => Promise.resolve(knowledge)
  });
  const recorder = new KnowledgeReceiptRecorder({
    write: ({ receipt }): Promise<string> => {
      receipts.push({ kind: receipt.kind });
      return Promise.resolve(`receipt/${receipt.id}.json`);
    }
  });
  let id = 0;
  return new GenerationPlanner({
    projectRoot: "/project",
    knowledge: loader,
    receipts: recorder,
    now: () => new Date("2026-09-06T00:00:00.000Z"),
    createReceiptId: () => `receipt-${String(++id)}`
  });
}

describe("GenerationPlanner", () => {
  it("recognizes and plans the first known Route", async () => {
    const receipts: { kind: string }[] = [];
    const result = await planner(receipts).planSnapshot(session(), snapshot());

    expect(result.planning).toMatchObject({
      currentScreen: "home",
      replansUsed: 0,
      currentRoute: {
        segments: [{ transitionId: "open-detail" }]
      }
    });
    expect(receipts).toEqual([{ kind: "screenDetection" }]);
    expect(result.timing.recognitionMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.planningMs).toBeGreaterThanOrEqual(0);
  });

  it("records deviation and uses one bounded re-plan", async () => {
    const receipts: { kind: string }[] = [];
    const first = await planner(receipts).planSnapshot(session(), snapshot());
    const deviatedSession: GenerationSession = {
      ...session(),
      planning: first.planning
    };
    const result = await planner(receipts).planSnapshot(
      deviatedSession,
      snapshot("com.example.app.PermissionActivity"),
      true
    );

    expect(result.planning).toMatchObject({
      currentScreen: "permission",
      replansUsed: 1,
      currentRoute: {
        segments: [{ transitionId: "permission-to-detail" }]
      }
    });
    expect(receipts.map((receipt) => receipt.kind)).toEqual([
      "screenDetection",
      "screenDetection",
      "transitionVerification",
      "replan"
    ]);
  });

  it("fails closed when the re-plan budget is exhausted", async () => {
    const current = session();
    const currentPlanning = current.planning;
    if (currentPlanning === undefined) {
      throw new Error("Test session planning is unavailable");
    }
    current.planning = {
      ...currentPlanning,
      replansUsed: 1,
      currentScreen: "home",
      currentRoute: {
        version: 1,
        goalId: "open-detail",
        knowledgeHash,
        startScreen: "home",
        targetScreen: "detail",
        segments: [{
          index: 0,
          transitionId: "open-detail",
          fromScreen: "home",
          toScreen: "detail",
          cost: 1.5
        }],
        totalCost: 1.5,
        plannedAt: "2026-09-06T00:00:00.000Z"
      }
    };

    await expect(planner([]).planSnapshot(
      current,
      snapshot("com.example.app.PermissionActivity"),
      true
    )).rejects.toMatchObject({ code: "REPLAN_BUDGET_EXHAUSTED" });
  });
});
