import { describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  KNOWLEDGE_DIR,
  activeGenerationBundleName,
  assertArtifactDirectory,
  assertProjectPathUnder,
  parseSnapshotEvidenceReference
} from "../../src/domain/workspace.js";

describe("workspace paths", () => {
  it("keeps the config inside the committed TapHound workspace", () => {
    expect(CONFIG_PATH).toBe(".taphound/config.json");
    expect(KNOWLEDGE_DIR).toBe(".taphound/knowledge");
  });

  it("rejects Core artifacts and generated files outside .taphound", () => {
    expect(() => {
      assertArtifactDirectory("/project", "reports");
    }).toThrow(/\.taphound\/build/i);
    expect(() => assertProjectPathUnder(
      "/project",
      "journeys/search.json",
      ".taphound/journeys",
      "Journey output"
    )).toThrow(/\.taphound\/journeys/i);
    expect(assertProjectPathUnder(
      "/project",
      ".taphound/journeys/search.json",
      ".taphound/journeys",
      "Journey output"
    )).toBe("/project/.taphound/journeys/search.json");
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

