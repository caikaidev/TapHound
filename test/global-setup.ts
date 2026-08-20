import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Builds the dist directory once before any test file runs.  Previously,
 * both `verify-process.test.ts` and `generation-process.test.ts` had their
 * own `beforeAll` build steps.  When vitest ran those files in parallel the
 * two `npm run build` invocations raced — the build script deletes `dist/`
 * before recompiling, so one build could wipe the output of the other.
 * Centralising the build here eliminates the race.
 */
export default function setup(): void {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const build = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || "TapHound build failed");
  }
}
