import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

async function releaseNotes(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["scripts/release-notes.mjs", ...args]
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("release-notes script", () => {
  it("has CHANGELOG notes for the current package version", async () => {
    // A version bump must add its CHANGELOG section, or the release fails.
    const { version } = JSON.parse(
      await readFile("package.json", "utf8")
    ) as { version: string };

    const notes = await releaseNotes("notes", version);

    expect(notes.code).toBe(0);
    expect(notes.stdout.trim()).not.toBe("");
    expect(notes.stdout).not.toMatch(/^## /m);
  });

  it("prints only the requested version's section", async () => {
    const notes = await releaseNotes("notes", "0.2.0-dev.10");

    expect(notes.code).toBe(0);
    expect(notes.stdout).toContain("### Removed");
    expect(notes.stdout).not.toContain("## Unreleased");
  });

  it("fails for a version without a section", async () => {
    const notes = await releaseNotes("notes", "9.9.9");

    expect(notes.code).toBe(1);
    expect(notes.stderr).toContain('CHANGELOG.md has no "## 9.9.9" section');
  });

  it.each([
    ["0.2.0-dev.10", "dev"],
    ["1.0.0-rc.1", "rc"],
    ["1.2.3", "latest"]
  ])("publishes %s under the %s dist-tag", async (version, tag) => {
    await expect(releaseNotes("dist-tag", version)).resolves
      .toMatchObject({ code: 0, stdout: `${tag}\n` });
  });

  it("rejects versions it cannot map to a dist-tag", async () => {
    await expect(releaseNotes("dist-tag", "1.0.0-1")).resolves
      .toMatchObject({ code: 1 });
    await expect(releaseNotes("dist-tag", "v1.0.0")).resolves
      .toMatchObject({ code: 1 });
  });
});
