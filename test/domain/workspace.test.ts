import { describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  BENCHMARKS_DIR,
  BENCHMARK_RUNS_DIR,
  GROUND_TRUTH_DIR,
  KNOWLEDGE_DIR,
  KNOWLEDGE_RECEIPTS_DIR,
  activeGenerationBundleName,
  legacyWorkspaceMessage,
  localTargetWorkspaceRoot,
  parseSnapshotEvidenceReference,
  tapHoundPath,
  TARGETS_DIR
} from "../../src/domain/workspace.js";

describe("workspace paths", () => {
  it("keeps the config inside the committed TapHound workspace", () => {
    expect(CONFIG_PATH).toBe(".taphound/config.json");
    expect(KNOWLEDGE_DIR).toBe(".taphound/knowledge");
    expect(BENCHMARKS_DIR).toBe(".taphound/benchmarks");
    expect(GROUND_TRUTH_DIR).toBe(".taphound/ground-truth");
    expect(KNOWLEDGE_RECEIPTS_DIR).toBe(
      ".taphound/build/knowledge-receipts"
    );
    expect(BENCHMARK_RUNS_DIR).toBe(".taphound/build/benchmark-runs");
  });
});

describe("parseSnapshotEvidenceReference", () => {
  it("accepts active and published bundles of the same generation", () => {
    const path = "evidence/snapshots/revision-000002/attempt-1/snapshot.json";
    expect(
      parseSnapshotEvidenceReference(
        `.taphound/build/generations/.generation-1.work/${path}`,
        "generation-1"
      )
    ).toBe(path);
    expect(
      parseSnapshotEvidenceReference(
        `.taphound/build/generations/generation-1/${path}`,
        "generation-1"
      )
    ).toBe(path);
  });

  it("rejects references to other generations or foreign paths", () => {
    const path = "evidence/snapshots/revision-000002/attempt-1/snapshot.json";
    expect(
      parseSnapshotEvidenceReference(
        `.taphound/build/generations/.generation-2.work/${path}`,
        "generation-1"
      )
    ).toBeNull();
    expect(
      parseSnapshotEvidenceReference(
        `.taphound/build/generations/${path}`,
        "generation-1"
      )
    ).toBeNull();
    expect(
      parseSnapshotEvidenceReference(
        ".taphound/build/jobs/other/snapshot.json",
        "generation-1"
      )
    ).toBeNull();
    expect(
      parseSnapshotEvidenceReference("", "generation-1")
    ).toBeNull();
  });
});

describe("activeGenerationBundleName", () => {
  it("derives the staging bundle name from the session id", () => {
    expect(activeGenerationBundleName("generation-1"))
      .toBe(".generation-1.work");
  });
});

describe("legacyWorkspaceMessage", () => {
  it("provides a build/runs migration target for stray root Verify runs", () => {
    const run = ".taphound/2026-08-06T12-34-56.789Z-123e4567-e89b-42d3-a456-426614174000";

    expect(legacyWorkspaceMessage([run])).toContain(
      `mv ${run} .taphound/build/runs/${run.slice(".taphound/".length)}`
    );
  });
});

describe("local target workspace", () => {
  it("derives the per-target workspace root", () => {
    expect(localTargetWorkspaceRoot("/repo/benchmarks", "work-app")).toBe(
      "/repo/benchmarks/.taphound/local/work-app"
    );
  });

  it("tapHoundPath is identity when no workspace root is set", () => {
    expect(tapHoundPath("/proj", undefined, ".taphound/knowledge")).toBe(
      "/proj/.taphound/knowledge"
    );
  });

  it("tapHoundPath rebases TapHound-owned data onto the workspace root", () => {
    expect(tapHoundPath("/real/app", "/ws", ".taphound/journeys/x.json")).toBe(
      "/ws/journeys/x.json"
    );
  });

  it("exposes the benchmarks targets directory constant", () => {
    expect(TARGETS_DIR).toBe("benchmarks");
  });
});
