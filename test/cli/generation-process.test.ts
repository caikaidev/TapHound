import {
  spawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, "dist", "cli", "main.js");

beforeAll(() => {
  const build = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || "TapHound build failed");
  }
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
});
