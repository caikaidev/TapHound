// Validate the publishable tarball file list without publishing the package.
import process from "node:process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const packages = JSON.parse(input);
if (!Array.isArray(packages) || packages.length !== 1) {
  throw new Error("Expected one npm pack --dry-run --json result");
}
const entries = new Set(packages[0].files.map((item) => item.path));
for (const name of ["tap-check", "tap-fix", "taphound-flash"]) {
  const skillMd = "field-skills/" + name + "/SKILL.md";
  if (!entries.has(skillMd)) throw new Error("Missing published Skill " + skillMd);
}
for (const required of [
  "field-skills/taphound-flash/scripts/feedback.mjs",
  "field-skills/taphound-flash/scripts/field-runner.mjs",
  "dist/cli/main.js"
]) {
  if (!entries.has(required)) throw new Error("Missing published file " + required);
}
if ([...entries].some((entry) => entry.startsWith("field-skills/tests/"))) {
  throw new Error("Synthetic Field Skills tests must not ship to npm consumers");
}
process.stdout.write("npm pack includes the three Field Skills and executable CLI\n");
