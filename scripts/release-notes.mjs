#!/usr/bin/env node
// Release metadata derived from the repository, used by the release workflow:
//   node scripts/release-notes.mjs notes <version>   CHANGELOG section for <version>
//   node scripts/release-notes.mjs dist-tag <version> npm dist-tag for <version>
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The body of the `## <version>` CHANGELOG section, without its heading. */
export function releaseSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
  return body.length === 0 ? undefined : body;
}

/**
 * A prerelease publishes under its first identifier (`0.2.0-dev.10` → `dev`)
 * so `latest` only ever moves to a stable version.
 */
export function distTag(version) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`Not a semantic version: ${version}`);
  const prerelease = match[4];
  if (prerelease === undefined) return "latest";
  const identifier = prerelease.split(".")[0] ?? "";
  if (!/^[A-Za-z][0-9A-Za-z-]*$/.test(identifier)) {
    throw new Error(`Prerelease ${version} needs a named first identifier`);
  }
  return identifier;
}

async function main(argv) {
  const [command, version] = argv;
  if (version === undefined || (command !== "notes" && command !== "dist-tag")) {
    throw new Error("Usage: release-notes.mjs <notes|dist-tag> <version>");
  }
  if (command === "dist-tag") {
    process.stdout.write(`${distTag(version)}\n`);
    return;
  }
  const changelog = await readFile(
    resolve(import.meta.dirname, "..", "CHANGELOG.md"),
    "utf8"
  );
  const section = releaseSection(changelog, version);
  if (section === undefined) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  }
  process.stdout.write(`${section}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
