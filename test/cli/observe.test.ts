import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, "dist", "cli", "main.js");
const fakeTool = join(
  repositoryRoot,
  "test",
  "fixtures",
  "bin",
  "fake-taphound-tool.mjs"
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

async function fixture(options: {
  invalidConfig?: boolean;
} = {}): Promise<ProcessFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-observe-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(fakeTool, join(bin, "adb"));
  await symlink(fakeTool, join(bin, "android"));
  const workspace = join(root, ".taphound");
  await mkdir(workspace);
  const configPath = join(workspace, "config.json");
  if (options.invalidConfig === true) {
    await writeFile(configPath, "{ not valid json\n");
  } else {
    await writeFile(configPath, `${JSON.stringify({
      version: 1,
      run: { packageName: "com.example.app", activity: ".MainActivity" },
      idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 10000 }
    })}\n`);
  }
  return { root, bin, configPath };
}

function runObserve(
  test: ProcessFixture,
  environment: Record<string, string> = {},
  extraArgs: readonly string[] = []
): CliProcessResult {
  const result = spawnSync(process.execPath, [
    cli,
    "observe",
    "--project",
    test.root,
    "--config",
    test.configPath,
    ...extraArgs
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
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

describe("built taphound observe process contract", () => {
  it("returns exit 0 with one JSON value containing a report", async () => {
    const test = await fixture();
    const result = runObserve(test, {}, ["--json"]);

    expect(result.status).toBe(0);
    const output = jsonOutput(result);
    expect(output).toMatchObject({ status: "observed", exitCode: 0 });
    const report = output.report as Record<string, unknown>;
    expect(report).toBeDefined();
    expect(report.foreground).toMatchObject({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity"
    });
    expect(report.activity).toBe("com.example.app.MainActivity");
    expect(Array.isArray(report.layout)).toBe(true);
    expect((report.layout as unknown[]).length).toBeGreaterThan(0);
    expect(report.logcat).toBeUndefined();
  }, 15000);

  it("returns exit 2 with CONFIG_INVALID when config is malformed", async () => {
    const test = await fixture({ invalidConfig: true });
    const result = runObserve(test, {}, ["--json"]);

    expect(result.status).toBe(2);
    expect(jsonOutput(result)).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
  });

  it("returns exit 3 when no device is available", async () => {
    const test = await fixture();
    const result = runObserve(test, { TAPHOUND_FAKE_DEVICE: "none" }, ["--json"]);

    expect(result.status).toBe(3);
    expect(jsonOutput(result)).toMatchObject({
      exitCode: 3,
      failure: { code: "DEVICE_UNAVAILABLE" }
    });
  });

  it("writes a human-readable summary including the activity in text mode", async () => {
    const test = await fixture();
    const result = runObserve(test, {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("com.example.app.MainActivity");
    expect(result.stdout).toContain("layout");
  }, 15000);

  it("does not require a legacy workspace guard (no .taphound/.gitignore required)", async () => {
    const test = await fixture();
    // No .gitignore is created because observe is read-only.
    await expect(access(join(test.root, ".taphound", ".gitignore")))
      .rejects.toThrow();
    const result = runObserve(test, {}, ["--json"]);
    expect(result.status).toBe(0);
  }, 15000);
});
