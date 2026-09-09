import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { childSpawnEnv } from "./spawn-env.js";

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, "dist", "cli", "main.js");
const fakeAdbTool = join(
  repositoryRoot,
  "test",
  "fixtures",
  "bin",
  "fake-taphound-tool.mjs"
);
const fakeMobileMcpTool = join(
  repositoryRoot,
  "test",
  "fixtures",
  "bin",
  "fake-mcp-server-mobile.mjs"
);
const temporaryRoots: string[] = [];

interface ProcessFixture {
  root: string;
  bin: string;
  configPath: string;
}

interface CliProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<ProcessFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-doctor-process-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(fakeAdbTool, join(bin, "adb"));
  await symlink(fakeAdbTool, join(bin, "android"));
  await symlink(fakeMobileMcpTool, join(bin, "mcp-server-mobile"));
  const workspace = join(root, ".taphound");
  await mkdir(workspace);
  const configPath = join(workspace, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    run: { packageName: "com.example.app", activity: ".MainActivity" },
    idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 10000 }
  })}\n`);
  return { root, bin, configPath };
}

function runDoctor(
  test: ProcessFixture,
  environment: Record<string, string> = {}
): CliProcessResult {
  const result = spawnSync(process.execPath, [
    cli,
    "doctor",
    "--project",
    test.root,
    "--json"
  ], {
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
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function jsonOutput(result: CliProcessResult): Record<string, unknown> {
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("built taphound doctor --json process contract", () => {
  it("reports the adb runtime backend by default", async () => {
    const test = await fixture();
    const result = runDoctor(test);

    expect(result.status).toBe(0);
    const report = jsonOutput(result);
    expect(report).toMatchObject({
      status: "passed",
      runtimeBackend: "adb",
      deviceSerial: "emulator-5554"
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "android", status: "passed" }),
      expect.objectContaining({ name: "mobile-mcp", status: "notRun" })
    ]));
  }, 20000);

  it("diagnoses through the Mobile MCP server under mobile-mcp", async () => {
    const test = await fixture();
    const result = runDoctor(test, {
      TAPHOUND_RUNTIME_BACKEND: "mobile-mcp"
    });

    expect(result.status).toBe(0);
    const report = jsonOutput(result);
    expect(report).toMatchObject({
      status: "passed",
      runtimeBackend: "mobile-mcp",
      deviceSerial: "emulator-5554"
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "android", status: "notRun" }),
      expect.objectContaining({
        name: "mobile-mcp", status: "passed", version: "9.9.9-fake"
      }),
      expect.objectContaining({
        name: "app", status: "passed", message: "com.example.app"
      }),
      expect.objectContaining({ name: "permissions", status: "passed" }),
      expect.objectContaining({
        name: "device", status: "passed", message: "emulator-5554"
      })
    ]));
  }, 20000);

  it("rejects an invalid runtime backend value with CONFIG_INVALID", async () => {
    const test = await fixture();
    const result = runDoctor(test, {
      TAPHOUND_RUNTIME_BACKEND: "emulator"
    });

    expect(result.status).toBe(2);
    const output = jsonOutput(result);
    expect(output).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    const failure = output.failure as { message?: string | undefined };
    expect(failure.message).toContain("TAPHOUND_RUNTIME_BACKEND");
    expect(result.stderr).toBe("");
  }, 20000);
});
