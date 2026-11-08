/**
 * Exercise the actual npm tarball from a fresh temporary project, not the source tree.
 * CI-only: build and npm dependencies must already be installed.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(root, ".field-pack-smoke-"));
function run(file, args, cwd, expected = 0) {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", timeout: 60000 });
  if (r.error || r.status !== expected) {
    throw new Error(file + " " + args.join(" ") + "\n" + (r.error?.message ?? "") +
      "\nexit: " + r.status + "\nstdout:\n" + r.stdout + "\nstderr:\n" + r.stderr);
  }
  return r.stdout.trim();
}
async function assertSkill(project, name) {
  const path = join(project, ".agents", "skills", name, "SKILL.md");
  await stat(path);
  const text = await readFile(path, "utf8");
  if (!text.includes("name: " + name)) throw Error("Wrong installed Skill: " + name);
}
async function init(cli, project, args, expectedExit = 0) {
  await mkdir(project, { recursive: true });
  const r = spawnSync(process.execPath, [cli, "init", "--agent", "codex", "--json", ...args], {
    cwd: project, encoding: "utf8", timeout: 20000
  });
  if (r.error || r.status !== expectedExit) {
    throw new Error("init result: " + (r.error?.message ?? "") + "\n" + r.stdout + "\n" + r.stderr);
  }
  return JSON.parse(r.stdout);
}
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], root);
  const tarball = (await readdir(temp)).find((x) => x.endsWith(".tgz"));
  if (!tarball) throw Error("npm pack produced no tarball");
  run("tar", ["-xzf", join(temp, tarball), "-C", temp], root);
  const cli = join(temp, "package", "dist", "cli", "main.js");
  const fieldProject = join(temp, "field-project");
  const first = await init(cli, fieldProject, []);
  if (first.status !== "installed" || first.skills.length !== 3) {
    throw Error("Expected three default Field Skills");
  }
  for (const name of ["tap-check", "tap-fix", "taphound-flash"]) await assertSkill(fieldProject, name);
  await stat(join(fieldProject, ".agents", "skills", "taphound-flash", "scripts", "feedback.mjs"));
  const original = await readFile(join(fieldProject, ".agents", "skills", "tap-check", "SKILL.md"), "utf8");
  const reinstalled = await init(cli, fieldProject, []);
  if (reinstalled.status !== "installed") throw Error("Same profile reinstall failed");
  if (original !== await readFile(join(fieldProject, ".agents", "skills", "tap-check", "SKILL.md"), "utf8")) {
    throw Error("Same profile changed shipped Skill unexpectedly");
  }
  const incompatible = await init(cli, fieldProject, ["--profile", "legacy"], 2);
  if (incompatible.failure?.code !== "SKILL_PROFILE_CONFLICT") {
    throw Error("Expected conflicting profile guard");
  }
  await stat(join(fieldProject, ".agents", "skills", "tap-check", "SKILL.md"));
  const legacyProject = join(temp, "legacy-project");
  const legacy = await init(cli, legacyProject, ["--profile", "legacy"]);
  if (legacy.status !== "installed" || legacy.skills.length !== 6) {
    throw Error("Expected six legacy skills");
  }
  for (const name of ["taphound-verify-change", "taphound-bug-fix", "taphound-flash"]) {
    await assertSkill(legacyProject, name);
  }
  const oldFlash = await readFile(join(legacyProject, ".agents", "skills", "taphound-flash", "SKILL.md"), "utf8");
  const conflict = await init(cli, legacyProject, [], 2);
  if (conflict.failure?.code !== "SKILL_PROFILE_CONFLICT") {
    throw Error("Expected conflict before Field installation");
  }
  if (oldFlash !== await readFile(join(legacyProject, ".agents", "skills", "taphound-flash", "SKILL.md"), "utf8")) {
    throw Error("Conflicting installation changed existing flash");
  }
  process.stdout.write("npm tarball smoke: default Field, explicit legacy, same-profile reinstall, both conflict directions passed\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
