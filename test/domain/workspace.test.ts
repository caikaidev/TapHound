import { describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  activeGenerationBundleName,
  legacyWorkspaceMessage,
  parseSnapshotEvidenceReference
} from "../../src/domain/workspace.js";

describe("workspace paths", () => {
  it("keeps the config inside the committed TapHound workspace", () => {
    expect(CONFIG_PATH).toBe(".taphound/config.json");
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
