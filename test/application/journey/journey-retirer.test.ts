import { describe, expect, it, vi } from "vitest";

import { JourneyRetirer } from "../../../src/application/journey/journey-retirer.js";
import { hashGenerationBinding } from "../../../src/application/generation/generation-starter.js";
import type { JourneyCompositionStore } from "../../../src/ports/journey-composition-store.js";

const NOW = new Date("2026-09-11T00:00:00.000Z");

const metaValue = {
  version: 1,
  status: "verified",
  generationId: "generation-1",
  journeyPath: ".taphound/journeys/search.json",
  bindings: {
    projectHash: hashGenerationBinding({
      projectRoot: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    }),
    configHash: hashGenerationBinding({}),
    contextHash: "c".repeat(64)
  },
  verification: {
    reportPath: "verification/report.json",
    reportSha256: "d".repeat(64),
    runId: "verify-run",
    runs: 1
  },
  manualOverrideStepIndexes: []
};

const journeyValue = {
  version: 2,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

function store(
  meta: Buffer | null,
  overrides: Partial<JourneyCompositionStore> = {}
): JourneyCompositionStore {
  return {
    read: vi.fn(() => Promise.resolve(
      Buffer.from(`${JSON.stringify(journeyValue)}\n`, "utf8")
    )),
    readJourneyMeta: vi.fn(() => Promise.resolve(meta)),
    writeText: vi.fn(() => Promise.resolve()),
    ...overrides
  } as unknown as JourneyCompositionStore;
}

function retirer(composition: JourneyCompositionStore): JourneyRetirer {
  return new JourneyRetirer({ store: composition });
}

describe("JourneyRetirer", () => {
  it("writes the retired marker into the meta sidecar", async () => {
    const composition = store(Buffer.from(`${JSON.stringify(metaValue)}\n`, "utf8"));
    const retir = retirer(composition);

    const result = await retir.retire({
      projectRoot: "/project",
      journeyPath: ".taphound/journeys/search.json",
      reason: "superseded by search-v2",
      now: NOW
    });

    expect(result.status).toBe("retired");
    expect(result.retiredAt).toBe(NOW.toISOString());
    const writeInput = vi.mocked(composition.writeText).mock.calls[0]?.[0] as {
      projectRoot: string;
      relativePath: string;
      content: string;
      workspaceRoot?: string | undefined;
    };
    expect(writeInput.projectRoot).toBe("/project");
    expect(writeInput.relativePath).toBe(".taphound/journeys/search.meta.json");
    expect(writeInput.content).toContain('"retired": {');
    expect(writeInput.workspaceRoot).toBeUndefined();
  });

  it("fails with META_MISSING when the sidecar is absent", async () => {
    const retir = retirer(store(null));
    await expect(retir.retire({
      projectRoot: "/project",
      journeyPath: ".taphound/journeys/search.json",
      reason: "obsolete",
      now: NOW
    })).rejects.toMatchObject({ code: "META_MISSING" });
  });

  it("fails with JOURNEY_ALREADY_RETIRED when already retired", async () => {
    const alreadyRetired = {
      ...metaValue,
      retired: {
        retiredAt: "2026-09-10T00:00:00.000Z",
        reason: "earlier"
      }
    };
    const retir = retirer(
      store(Buffer.from(`${JSON.stringify(alreadyRetired)}\n`, "utf8"))
    );
    await expect(retir.retire({
      projectRoot: "/project",
      journeyPath: ".taphound/journeys/search.json",
      reason: "again",
      now: NOW
    })).rejects.toMatchObject({ code: "JOURNEY_ALREADY_RETIRED" });
  });

  it("fails with JOURNEY_NOT_FOUND when the journey is unreadable", async () => {
    const composition = store(Buffer.from("x"), {
      read: vi.fn(() => Promise.reject(new Error("missing")))
    });
    await expect(retirer(composition).retire({
      projectRoot: "/project",
      journeyPath: ".taphound/journeys/search.json",
      reason: "obsolete",
      now: NOW
    })).rejects.toMatchObject({ code: "JOURNEY_NOT_FOUND" });
  });
});