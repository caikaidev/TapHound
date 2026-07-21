import { spawnSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(repositoryRoot, "dist");
const compiler = resolve(
  repositoryRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);

await rm(outputDirectory, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [compiler, "-p", resolve(repositoryRoot, "tsconfig.build.json")],
  {
    cwd: repositoryRoot,
    stdio: "inherit"
  }
);

if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  await chmod(resolve(outputDirectory, "cli", "main.js"), 0o755);
}
