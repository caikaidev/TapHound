import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.env.TAPHOUND_ACCEPTANCE_DEVICE !== "1") {
  process.stderr.write(
    "Skipping device acceptance. Set TAPHOUND_ACCEPTANCE_DEVICE=1 to opt in.\n"
  );
  process.exit(0);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(
  repositoryRoot,
  "examples",
  "taphound-android-demo"
);
const cli = resolve(repositoryRoot, "dist", "cli", "main.js");
const gradleWrapper = resolve(projectRoot, "gradlew");

try {
  await access(cli);
} catch {
  throw new Error("Build TapHound first with `npm run build`");
}

try {
  await access(gradleWrapper);
} catch {
  throw new Error(
    "Device acceptance requires a Gradle Wrapper at "
      + "examples/taphound-android-demo/gradlew"
  );
}

const result = spawnSync(process.execPath, [
  cli,
  "verify",
  "--project",
  projectRoot,
  "--config",
  resolve(projectRoot, "taphound.config.json"),
  "--journey",
  resolve(projectRoot, "journeys", "search.json"),
  "--json"
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 4);
}

const output = JSON.parse(result.stdout);
if (output.status !== "passed") {
  throw new Error("TapHound device acceptance did not pass");
}
