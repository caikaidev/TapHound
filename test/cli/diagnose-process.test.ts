import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticsBundleSchema } from "../../src/domain/diagnostics.js";
import { childSpawnEnv } from "./spawn-env.js";

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, "dist", "cli", "main.js");
const fakeTool = join(repositoryRoot, "test", "fixtures", "bin", "fake-taphound-tool.mjs");
const temporaryRoots: string[] = [];

const PACKAGE = "com.example.app";
const JOURNEY_NAME = "Secret checkout journey";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

interface Fixture {
  root: string;
  bin: string;
  journeyPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-diagnose-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(fakeTool, join(bin, "adb"));
  await symlink(fakeTool, join(bin, "android"));
  await mkdir(join(root, ".taphound"));
  await writeFile(join(root, ".taphound", "config.json"), `${JSON.stringify({
    version: 1,
    run: { packageName: PACKAGE, activity: ".MainActivity" },
    runtime: { backend: "adb" },
    ui: { backend: "system-uiautomator" },
    idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 10000 },
    artifactsDir: ".taphound/build/runs"
  })}\n`);
  const journeyPath = join(root, "journey.json");
  await writeFile(journeyPath, `${JSON.stringify({
    version: 2,
    name: JOURNEY_NAME,
    devices: [{ role: "default" }],
    steps: [{
      action: "wait",
      activity: {
        before: `${PACKAGE}.MainActivity`,
        after: `${PACKAGE}.MainActivity`
      }
    }]
  })}\n`);
  return { root, bin, journeyPath };
}

function run(
  test: Fixture,
  args: readonly string[],
  environment: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...childSpawnEnv(),
      PATH: `${test.bin}${delimiter}${process.env.PATH ?? ""}`,
      TAPHOUND_FAKE_ROOT: test.root,
      ...environment
    }
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function verify(test: Fixture, environment: Record<string, string> = {}): void {
  const result = run(test, [
    "verify", "--project", test.root, "--journey", test.journeyPath, "--json"
  ], environment);
  expect(result.status).toBe(0);
}

describe("built taphound diagnose export", () => {
  it("journals invocations and exports a bundle without project specifics", async () => {
    const test = await fixture();
    verify(test);
    verify(test, { TAPHOUND_DIAGNOSTICS: "off" });

    const journal = await readFile(
      join(test.root, ".taphound", "build", "log", "events.jsonl"),
      "utf8"
    );
    expect(journal.trim().split("\n")).toHaveLength(1);

    const exported = run(test, ["diagnose", "export", "--project", test.root, "--json"]);
    expect(exported.status).toBe(0);
    expect(exported.stderr).toContain("Review the file before sharing it");
    const output = JSON.parse(exported.stdout) as { path: string; events: number; runs: number };
    expect(output).toMatchObject({ events: 1, runs: 1 });
    const text = await readFile(output.path, "utf8");
    const bundle = DiagnosticsBundleSchema.parse(JSON.parse(text));

    expect(bundle.journal.events).toMatchObject([{
      command: "verify",
      flags: ["project", "journey", "json"],
      exitCode: 0,
      status: "passed",
      runId: "run#1"
    }]);
    expect(bundle.config).toMatchObject({
      idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 10000 },
      ui: { backend: "system-uiautomator" }
    });
    expect(bundle.runs).toMatchObject([{
      run: "run#1",
      status: "passed",
      journey: "journey#1",
      devices: [{ device: "device#1" }],
      steps: [{
        index: 0,
        action: "wait",
        status: "passed",
        activity: {
          before: { status: "passed", expected: "activity#1", actual: "activity#1" }
        }
      }]
    }]);

    const canonicalRoot = await realpath(test.root);
    for (const sensitive of [
      test.root,
      canonicalRoot,
      tmpdir(),
      PACKAGE,
      "MainActivity",
      JOURNEY_NAME,
      "emulator-5554"
    ]) {
      expect(text).not.toContain(sensitive);
      expect(journal).not.toContain(sensitive);
    }
  }, 45_000);

  it("fails closed outside a TapHound project and creates nothing", async () => {
    const test = await fixture();
    const outside = join(test.root, "not-a-project");
    await mkdir(outside);

    const result = run(test, ["diagnose", "export", "--project", outside, "--json"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: { code: "CONFIG_INVALID" } });
    await expect(access(join(outside, ".taphound"))).rejects.toThrow();
  }, 15_000);
});
