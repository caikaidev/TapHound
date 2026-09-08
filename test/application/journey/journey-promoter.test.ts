import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { JourneyPromoter } from "../../../src/application/journey/journey-promoter.js";
import {
  GenerationMetaSchema,
  type GenerationMeta
} from "../../../src/domain/generation.js";
import { JourneySchema } from "../../../src/domain/journey.js";
import type { TapHoundReport } from "../../../src/domain/report.js";
import type { JourneyCompositionStore } from "../../../src/ports/journey-composition-store.js";
import { validReport } from "../../fixtures/report.js";

const JOURNEY_PATH = ".taphound/journeys/generated.json";
const META_PATH = ".taphound/journeys/generated.meta.json";
const GENERATION_ID = "644a6a0d-bc9a-414d-8f88-addbf8d31ca7";
const BUNDLE_ROOT = `.taphound/build/generations/${GENERATION_ID}`;

function journeyBytes(): Buffer {
  const journey = JourneySchema.parse({
    version: 2,
    name: "Generated",
    devices: [{ role: "default" }],
    steps: [{
      action: "click",
      locator: { resourceId: "com.example.app:id/button" },
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.SearchActivity"
      }
    }]
  });
  return Buffer.from(`${JSON.stringify(journey, null, 2)}\n`);
}

function reportBytes(runId = "verify-run"): Buffer {
  const report: TapHoundReport = validReport({ runId });
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
}

function validMeta(reportSha256: string): GenerationMeta {
  return GenerationMetaSchema.parse({
    version: 1,
    status: "verified",
    generationId: GENERATION_ID,
    journeyPath: JOURNEY_PATH,
    bindings: {
      projectHash: "a".repeat(64),
      configHash: "b".repeat(64),
      contextHash: "c".repeat(64)
    },
    verification: {
      reportPath: "verification/report.json",
      reportSha256,
      runId: "verify-run",
      runs: 1
    },
    manualOverrideStepIndexes: []
  });
}

interface Harness {
  promote: JourneyPromoter["promote"];
  writeText: ReturnType<typeof vi.fn>;
}

function harness(input: {
  journey?: Buffer | null;
  meta?: Buffer | null;
  report?: Buffer | null;
  verifiedJourney?: Buffer | null;
}): Harness {
  const writeText = vi.fn(() => Promise.resolve());
  const report = input.report ?? reportBytes();
  const meta = input.meta
    ?? Buffer.from(`${JSON.stringify(
      validMeta(createHash("sha256").update(report).digest("hex")),
      null,
      2
    )}\n`);
  const store: Pick<
    JourneyCompositionStore,
    "read" | "readJourneyMeta" | "writeText"
  > = {
    read: vi.fn(({ relativePath }: { relativePath: string }) => {
      if (relativePath === JOURNEY_PATH) {
        return input.journey === null
          ? Promise.reject(new Error("not found"))
          : Promise.resolve(input.journey ?? journeyBytes());
      }
      if (relativePath === `${BUNDLE_ROOT}/verification/report.json`) {
        return input.report === null
          ? Promise.reject(new Error("not found"))
          : Promise.resolve(report);
      }
      if (relativePath === `${BUNDLE_ROOT}/verified/journey.json`) {
        return input.verifiedJourney === null
          ? Promise.reject(new Error("not found"))
          : Promise.resolve(input.verifiedJourney ?? journeyBytes());
      }
      return Promise.reject(new Error(`unexpected read: ${relativePath}`));
    }),
    readJourneyMeta: vi.fn(() => (
      input.meta === null
        ? Promise.resolve(null)
        : Promise.resolve(meta)
    )),
    writeText
  };
  return { promote: new JourneyPromoter({ store }).promote, writeText };
}

describe("JourneyPromoter", () => {
  it("promotes a verified Journey with intact evidence", async () => {
    const { promote, writeText } = harness({});
    const result = await promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "core regression path",
      now: new Date("2026-01-02T00:00:00.000Z")
    });
    expect(result).toEqual({
      status: "promoted",
      journeyPath: JOURNEY_PATH,
      metaPath: META_PATH,
      generationId: GENERATION_ID,
      promotedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writeArg = writeText.mock.calls[0]?.[0] as {
      projectRoot: string;
      relativePath: string;
      content: string;
    };
    expect(writeArg).toMatchObject({
      projectRoot: "/project",
      relativePath: META_PATH
    });
    const written = JSON.parse(writeArg.content) as {
      status: string;
      promotion: { promotedAt: string; reason: string };
    };
    expect(written.status).toBe("promoted");
    expect(written.promotion).toEqual({
      promotedAt: "2026-01-02T00:00:00.000Z",
      reason: "core regression path"
    });
  });

  it("rejects a missing Journey", async () => {
    const { promote } = harness({ journey: null });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "JOURNEY_NOT_FOUND" });
  });

  it("rejects a Journey without a meta sidecar", async () => {
    const { promote } = harness({ meta: null });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "META_MISSING" });
  });

  it("rejects an invalid meta sidecar", async () => {
    const { promote } = harness({ meta: Buffer.from("{ not json") });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "META_INVALID" });
  });

  it("rejects an already promoted Journey", async () => {
    const base = validMeta("d".repeat(64));
    const { promote } = harness({
      meta: Buffer.from(`${JSON.stringify({
        ...base,
        status: "promoted",
        promotion: {
          promotedAt: "2026-01-01T00:00:00.000Z",
          reason: "already done"
        }
      }, null, 2)}\n`)
    });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "JOURNEY_ALREADY_PROMOTED" });
  });

  it("rejects missing verification evidence", async () => {
    const { promote } = harness({ report: null });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "EVIDENCE_MISSING" });
  });

  it("rejects tampered verification evidence", async () => {
    const { promote } = harness({
      meta: Buffer.from(`${JSON.stringify(
        validMeta("0".repeat(64)),
        null,
        2
      )}\n`)
    });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "EVIDENCE_HASH_MISMATCH" });
  });

  it("rejects a Journey that drifted from its verified evidence", async () => {
    const drifted = JSON.parse(
      journeyBytes().toString("utf8")
    ) as Record<string, unknown>;
    drifted.name = "Renamed";
    const { promote } = harness({
      journey: Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`)
    });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "JOURNEY_MODIFIED" });
  });

  it("rejects a Journey that no longer parses", async () => {
    const invalid = Buffer.from(`${JSON.stringify({
      version: 2,
      name: "Generated",
      devices: [{ role: "default" }],
      steps: "not-steps"
    }, null, 2)}\n`);
    const { promote } = harness({ journey: invalid });
    await expect(promote({
      projectRoot: "/project",
      journeyPath: JOURNEY_PATH,
      reason: "why",
      now: new Date()
    })).rejects.toMatchObject({ code: "JOURNEY_INVALID" });
  });
});
