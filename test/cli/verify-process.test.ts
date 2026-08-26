import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
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
  journeyPath: string;
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
  invalidJourney?: boolean;
  blockedReports?: boolean;
} = {}): Promise<ProcessFixture> {
  const root = await mkdtemp(join(tmpdir(), "taphound-process-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(fakeTool, join(bin, "adb"));
  await symlink(fakeTool, join(bin, "android"));
  const workspace = join(root, ".taphound");
  await mkdir(workspace);
  const configPath = join(workspace, "config.json");
  const journeyPath = join(root, "journey.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    run: { packageName: "com.example.app", activity: ".MainActivity" },
    idle: { pollIntervalMs: 10, stablePolls: 1, timeoutMs: 10000 },
    artifactsDir: options.blockedReports === true
      ? "blocked/reports"
      : "reports"
  })}\n`);
  await writeFile(journeyPath, `${JSON.stringify({
    version: 1,
    name: "Process contract",
    steps: options.invalidJourney === true ? [] : [{
      action: "wait",
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.MainActivity"
      }
    }]
  })}\n`);
  if (options.blockedReports === true) {
    await writeFile(join(root, "blocked"), "not a directory");
  }
  return { root, bin, configPath, journeyPath };
}

function runVerify(
  test: ProcessFixture,
  environment: Record<string, string> = {},
  extraArgs: readonly string[] = []
): CliProcessResult {
  const result = spawnSync(process.execPath, [
    cli,
    "verify",
    "--project",
    test.root,
    "--config",
    test.configPath,
    "--journey",
    test.journeyPath,
    ...extraArgs,
    "--json"
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

describe("built taphound verify --json process contract", () => {
  it("builds an executable package entry point", async () => {
    await expect(access(cli, constants.X_OK)).resolves.toBeUndefined();
  });

  it("runs when invoked through a package-manager symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "taphound-bin-test-"));
    temporaryRoots.push(root);
    const binary = join(root, "taphound");
    await symlink(cli, binary);

    const result = spawnSync(process.execPath, [binary, "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: taphound");
  });

  it("returns exit 0 with machine-only stdout and a published report", async () => {
    const test = await fixture();
    const result = runVerify(test);

    expect(result.status).toBe(0);
    expect(jsonOutput(result)).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.stderr).toContain("TapHound: verifying Process contract");
    const output = jsonOutput(result);
    const reportPath = output.reportPath;
    expect(typeof reportPath).toBe("string");
    await expect(access(String(reportPath), constants.R_OK)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(String(reportPath), "utf8")))
      .toMatchObject({ status: "passed" });
    await expect(readFile(
      join(test.root, ".taphound", ".gitignore"),
      "utf8"
    )).resolves.toBe("build/\n");
  }, 15000);

  it("rejects --reports at the workspace root before device work", async () => {
    const test = await fixture();
    const result = runVerify(test, {}, ["--reports", ".taphound"]);

    expect(result.status).toBe(2);
    expect(jsonOutput(result)).toMatchObject({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID" }
    });
    expect(result.stderr).toBe("");
  });

  it.each([
    [2, { invalidJourney: true }, {}],
    [3, {}, { TAPHOUND_FAKE_DEVICE: "none" }],
    [3, {}, { TAPHOUND_FAKE_APP: "absent" }],
    [4, { blockedReports: true }, {}]
  ] as const)("returns one JSON value with process exit %s", async (
    exitCode,
    fixtureOptions,
    environment
  ) => {
    const test = await fixture(fixtureOptions);
    const result = runVerify(test, environment);

    expect(result.status).toBe(exitCode);
    expect(jsonOutput(result)).toMatchObject({ exitCode });
  });
});
