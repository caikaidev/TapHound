import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const taphoundCommand = process.platform === "win32"
  ? "taphound.cmd"
  : "taphound";

function run(command, args, label) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(npmCommand, ["test"], "Run tests");
run(npmCommand, ["run", "typecheck"], "Type-check");
run(npmCommand, ["run", "lint"], "Lint");
run(npmCommand, ["run", "build"], "Build");
run(
  process.execPath,
  [resolve(repositoryRoot, "dist", "cli", "main.js"), "--version"],
  "Verify built CLI version"
);
run(npmCommand, ["link"], "Register global taphound command");
run(taphoundCommand, ["--version"], "Verify registered taphound version");
run(taphoundCommand, ["--help"], "Verify registered taphound command");

process.stdout.write(
  "\nTapHound is ready. Run `taphound doctor --project <android-project>` "
    + "to check an Android environment.\n"
);
