import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import {
  mkdir,
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
  projectRoot = await mkdtemp(join(tmpdir(), "taphound-generation-process-"));
  const workspace = join(projectRoot, ".taphound");
  await mkdir(workspace);
  await writeFile(join(workspace, "config.json"), JSON.stringify({
    version: 1,
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
    ["bridge", ["generation", "bridge", "--session", "generation-1", "--json"]],
    ["archive", ["generation", "archive", "--session", "generation-1", "--json"]],
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
      "bridge",
      [
        "generation", "bridge", "--session", "../invalid",
        "--scenario", "photoCapture",
        "--trigger-locator", '{"resourceId":"com.example.app:id/button"}'
      ]
    ],
    [
      "archive",
      ["generation", "archive", "--session", "../invalid"]
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
