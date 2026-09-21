import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BaselineSchema } from "../../../src/domain/checkpoint.js";
import {
  AcceptanceContractSchema, ContractVerdictViewSchema
} from "../../../src/domain/contract.js";
import { GenerationMetaSchema } from "../../../src/domain/generation.js";
import { JourneySchema } from "../../../src/domain/journey.js";
import { hashJourney } from "../../../src/domain/report.js";
import { validReport } from "../../fixtures/report.js";
import search from "../../fixtures/journeys/search.json" with { type: "json" };

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = join(repo, "assets", "skills", "taphound-preserve", "scripts", "handoff.mjs");
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

type HelperResult = { status: string; reason?: string; handoff?: string; staged?: string[] };
function command(...argv: string[]): { code: number; output: HelperResult } {
  const result = spawnSync(process.execPath, [helper, ...argv], { encoding: "utf8" });
  return {
    code: result.status ?? -1,
    output: JSON.parse(result.stdout) as HelperResult
  };
}
async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function setup(mode: "journey" | "contract" = "journey"): Promise<{
  base: string; target: string; shared: string; input: string;
  journey: string; before: string; contract: string;
}> {
  // A historical worktree fixture lives inside the repo so git -C can
  // resolve a real HEAD without inventing Git identity or a commit.
  const base = await mkdtemp(join(repo, "test", "fixtures", ".handoff-base-"));
  const target = await realpath(await mkdtemp(join(tmpdir(), "taphound-handoff-target-")));
  const shared = await realpath(await mkdtemp(join(tmpdir(), "taphound-handoff-shared-")));
  created.push(base, target, shared);
  const journey = join(base, ".taphound/journeys/search.json");
  const meta = join(base, ".taphound/journeys/search.meta.json");
  const baseline = join(base, ".taphound/baselines/search.json");
  const before = join(base, ".taphound/build/runs/run-123");
  const contract = join(base, ".taphound/contracts/search.json");
  const apk = join(base, "app.apk");
  const input = join(base, "input.json");
  const parsedJourney = JourneySchema.parse(search);
  const journeySha = hashJourney(parsedJourney);
  const report = validReport({
    project: {
      root: base, packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "Search", sha256: journeySha },
    artifacts: {
      directory: before, report: "report.json", summary: "summary.txt",
      screenshots: [], logcats: [], stepLogs: []
    }
  });
  const contractText = `${JSON.stringify(AcceptanceContractSchema.parse({
    version: 1, id: "search", goal: "Search still opens",
    journey: { path: ".taphound/journeys/search.json", sha256: journeySha },
    assertions: [{
      type: "activity", activity: "com.example.app.SearchActivity", timeoutMs: 2000
    }]
  }), null, 2)}\n`;
  const baselineValue = BaselineSchema.parse({
    version: 1, id: "search-baseline",
    capturedAt: "2026-07-19T10:01:00.000Z",
    packageName: "com.example.app", runId: report.runId,
    journeySha256: journeySha,
    ...(mode === "contract" ? { contractSha256: sha(contractText) } : {}),
    activities: [{
      stepIndex: 0,
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }],
    elements: [], screens: [], requiredEvidence: { screens: false },
    sourceReportPath: join(before, "report.json")
  });
  await put(journey, parsedJourney);
  await put(meta, GenerationMetaSchema.parse({
    version: 1, status: "verified", generationId: "generation-1",
    journeyPath: ".taphound/journeys/search.json",
    journeySha256: journeySha,
    bindings: {
      projectHash: "a".repeat(64), configHash: "b".repeat(64),
      contextHash: "c".repeat(64)
    },
    verification: {
      reportPath: "verification/report.json", reportSha256: "d".repeat(64),
      runId: "generation-run", runs: 1
    },
    manualOverrideStepIndexes: [],
    replayPolicy: {
      generatedReplayPolicy: true, requireFocusedInput: true,
      idle: {
        strategy: "structural", pollIntervalMs: 250, stablePolls: 2, timeoutMs: 5000
      }
    }
  }));
  await put(baseline, baselineValue);
  await put(join(before, "report.json"), report);
  await writeFile(apk, "fixture-built-apk");
  if (mode === "contract") {
    await mkdir(dirname(contract), { recursive: true });
    await writeFile(contract, contractText);
    await put(join(before, "verdict.json"), ContractVerdictViewSchema.parse({
      version: 1, contractId: "search", verdict: "pass",
      reason: "CONTRACT_OK", message: "Accepted", preconditions: [],
      assertions: [{ type: "activity", status: "passed" }],
      evidence: [], reportStatus: "passed",
      contractSha256: sha(contractText), journeySha256: journeySha,
      reportPath: join(before, "report.json"),
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:01.000Z",
      environment: {
        projectRoot: base, packageName: "com.example.app",
        devices: ["emulator-5554"]
      }
    }));
  }
  await put(join(target, ".taphound/config.json"), {
    version: 1, run: { packageName: "com.example.app", activity: ".MainActivity" }
  });
  await put(input, {
    version: 1, caseId: "search-preserve",
    requirement: { sourceRef: "test-case", summary: "Search remains equivalent" },
    base: {
      projectRoot: base, apkPath: apk, installedApkSha256: sha("fixture-built-apk"),
      packageName: "com.example.app", deviceSerial: "emulator-5554"
    },
    mode,
    artifacts: {
      journeyPath: journey, metaPath: meta, baselinePath: baseline,
      beforeRunDir: before,
      ...(mode === "contract" ? { contractPath: contract } : {})
    }
  });
  return { base, target, shared, input, journey, before, contract };
}
function prepare(input: string, shared: string): string {
  const result = command("prepare", "--input", input, "--out", shared);
  expect(result.code, JSON.stringify(result.output)).toBe(0);
  expect(result.output.status).toBe("READY");
  return result.output.handoff ?? "";
}

describe("packaged Preserve handoff", () => {
  it("publishes a portable MD entry and stages identical, frozen assets in a second worktree", async () => {
    const fixture = await setup("contract");
    await writeFile(join(fixture.before, "logcat-default.txt"), "private-raw-log");
    const handoff = prepare(fixture.input, fixture.shared);
    const dir = dirname(handoff);
    expect(await readFile(handoff, "utf8")).toContain("Agent A attests");
    expect(await readFile(join(dir, "before-run/report.json"), "utf8")).toContain("passed");
    await expect(readFile(join(dir, "before-run/logcat-default.txt"))).rejects.toThrow();
    expect(command("validate", "--handoff", handoff, "--project", fixture.target))
      .toMatchObject({ code: 0, output: { status: "READY" } });
    expect(command("stage", "--handoff", handoff, "--project", fixture.target))
      .toMatchObject({ code: 0, output: { status: "READY" } });
    expect(await readFile(join(fixture.target, ".taphound/journeys/search.json")))
      .toEqual(await readFile(join(dir, "journey.json")));
    expect(await readFile(join(fixture.target, ".taphound/contracts/search.json")))
      .toEqual(await readFile(join(dir, "contract.json")));
    expect(command("stage", "--handoff", handoff, "--project", fixture.target).code).toBe(0);
    expect(command("prepare", "--input", fixture.input, "--out", fixture.shared))
      .toMatchObject({ code: 2, output: { status: "PAUSED" } });
  });

  it("pauses on tampered MD, manifest, or frozen artifact", async () => {
    const fixture = await setup();
    const handoff = prepare(fixture.input, fixture.shared);
    await writeFile(handoff, "changed");
    expect(command("validate", "--handoff", handoff).code).toBe(2);
    const second = await setup();
    const other = prepare(second.input, second.shared);
    const manifest = join(dirname(other), "handoff.json");
    await writeFile(manifest,
      (await readFile(manifest, "utf8")).replace('"READY"', '"PAUSED"'));
    expect(command("validate", "--handoff", other).code).toBe(2);
    const third = await setup();
    const thirdMd = prepare(third.input, third.shared);
    await writeFile(join(dirname(thirdMd), "journey.json"), "{}");
    expect(command("validate", "--handoff", thirdMd).code).toBe(2);
    const fourth = await setup();
    const fourthMd = prepare(fourth.input, fourth.shared);
    const fourthDir = dirname(fourthMd);
    const changed = "{}";
    await writeFile(join(fourthDir, "journey.json"), changed);
    const data = JSON.parse(await readFile(join(fourthDir, "handoff.json"), "utf8")) as {
      artifacts: Record<string, string>;
    };
    data.artifacts["journey.json"] = sha(changed);
    await put(join(fourthDir, "handoff.json"), data);
    expect(command("validate", "--handoff", fourthMd).code).toBe(2);
    const fifth = await setup();
    const fifthMd = prepare(fifth.input, fifth.shared);
    await writeFile(join(dirname(fifthMd), "unlisted.txt"), "surprise");
    expect(command("validate", "--handoff", fifthMd).code).toBe(2);
  });

  it("refuses wrong target package and conflicting existing assets before copying anything", async () => {
    const fixture = await setup();
    const handoff = prepare(fixture.input, fixture.shared);
    const targetJourney = join(fixture.target, ".taphound/journeys/search.json");
    await put(targetJourney, { conflict: true });
    expect(command("stage", "--handoff", handoff, "--project", fixture.target))
      .toMatchObject({ code: 2, output: { status: "PAUSED" } });
    await expect(readFile(join(fixture.target, ".taphound/journeys/search.meta.json")))
      .rejects.toThrow();
    expect(await readFile(targetJourney, "utf8")).toContain("conflict");
    await put(join(fixture.target, ".taphound/config.json"), {
      run: { packageName: "com.other.app" }
    });
    expect(command("validate", "--handoff", handoff, "--project", fixture.target).code).toBe(2);
  });

  it("rejects missing before-run evidence, false APK attestation, and mismatched provenance", async () => {
    const fixture = await setup();
    await rm(join(fixture.before, "report.json"));
    expect(command("prepare", "--input", fixture.input, "--out", fixture.shared).code).toBe(2);
    const other = await setup();
    const input = JSON.parse(await readFile(other.input, "utf8")) as {
      base: { installedApkSha256: string };
    };
    input.base.installedApkSha256 = "0".repeat(64);
    await put(other.input, input);
    expect(command("prepare", "--input", other.input, "--out", other.shared).code).toBe(2);
    const third = await setup();
    const baseline = join(third.base, ".taphound/baselines/search.json");
    const content = JSON.parse(await readFile(baseline, "utf8")) as {
      sourceReportPath: string;
    };
    content.sourceReportPath = "/another-run/report.json";
    await put(baseline, content);
    expect(command("prepare", "--input", third.input, "--out", third.shared).code).toBe(2);
    const contractCase = await setup("contract");
    await rm(join(contractCase.before, "verdict.json"));
    expect(command("prepare", "--input", contractCase.input, "--out", contractCase.shared).code)
      .toBe(2);
    const wrongContract = await setup("contract");
    await writeFile(wrongContract.contract, "changed contract");
    expect(command("prepare", "--input", wrongContract.input, "--out", wrongContract.shared).code)
      .toBe(2);
    const wrongMeta = await setup();
    const metaPath = join(wrongMeta.base, ".taphound/journeys/search.meta.json");
    const metaValue = JSON.parse(await readFile(metaPath, "utf8")) as {
      journeySha256: string;
    };
    metaValue.journeySha256 = "a".repeat(64);
    await put(metaPath, metaValue);
    expect(command("prepare", "--input", wrongMeta.input, "--out", wrongMeta.shared).code).toBe(2);
  });

  it("rejects symlinked evidence and symlinked target asset directories", async () => {
    const fixture = await setup();
    const meta = join(fixture.base, ".taphound/journeys/search.meta.json");
    const content = await readFile(meta);
    await rm(meta);
    await writeFile(join(fixture.base, "other-meta.json"), content);
    await symlink(join(fixture.base, "other-meta.json"), meta);
    expect(command("prepare", "--input", fixture.input, "--out", fixture.shared).code).toBe(2);
    const other = await setup();
    const handoff = prepare(other.input, other.shared);
    await symlink(other.base, join(other.target, ".taphound/journeys"));
    expect(command("stage", "--handoff", handoff, "--project", other.target).code).toBe(2);
  });
});
