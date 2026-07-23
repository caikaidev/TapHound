import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, "dist", "cli", "main.js");
let projectRoot = "";

beforeAll(async () => {
  const build = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || "TapHound build failed");
  }
  projectRoot = await mkdtemp(join(tmpdir(), "taphound-generation-process-"));
  await writeFile(join(projectRoot, "taphound.config.json"), JSON.stringify({
    version: 1,
    build: { task: ":app:assembleDebug" },
    artifact: { target: "app", variant: "debug" },
    run: {
      packageName: "com.example.app",
      activity: ".MainActivity"
    },
    idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 1000 },
    artifactsDir: "artifacts"
  }));
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function run(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

describe("built generation CLI process contract", () => {
  it.each([
    ["step", ["generation", "step", "--session", "generation-1", "--json"]],
    ["confirm", ["generation", "confirm", "--session", "generation-1", "--json"]],
    ["manual", ["generation", "manual", "--session", "generation-1", "--json"]],
    ["finalize", ["generation", "finalize", "--session", "generation-1", "--json"]]
  ])("emits one JSON result for %s Commander validation", (
    _command,
    args
  ) => {
    const result = run(args);

    expect(result.status).toBe(2);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
  });

  it("does not expose a built-in goal command", () => {
    const result = run(["generate", "--goal", "buy milk", "--json"]);

    expect(result.status).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      exitCode: 2
    });
  });

  it.each([
    ["observe", ["generation", "observe", "--session", "../invalid"]],
    [
      "step",
      [
        "generation", "step", "--session", "../invalid",
        "--input", "missing.json"
      ]
    ],
    [
      "confirm",
      [
        "generation", "confirm", "--session", "../invalid",
        "--challenge", "challenge-1"
      ]
    ],
    [
      "manual",
      [
        "generation", "manual", "--session", "../invalid",
        "--action", "wait"
      ]
    ],
    [
      "finalize",
      [
        "generation", "finalize", "--session", "../invalid",
        "--context", "missing.json", "--output", "journey.json"
      ]
    ]
  ])("rejects malformed %s session IDs before process side effects", (
    _command,
    args
  ) => {
    const result = run([...args, "--project", projectRoot, "--json"]);

    expect(result.status).toBe(2);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      exitCode: 2
    });
  });

  it("rejects a malformed challenge ID as validation failure", () => {
    const result = run([
      "generation", "confirm",
      "--session", "generation-1",
      "--challenge", "../invalid",
      "--project", projectRoot,
      "--json"
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "error",
      exitCode: 2
    });
  });
});
