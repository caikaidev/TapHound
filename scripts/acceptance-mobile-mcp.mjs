import { spawnSync } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { requireInstalledApp } from "./require-installed-app.mjs";

if (process.env.TAPHOUND_MOBILE_MCP_DEVICE !== "1") {
  process.stderr.write(
    "Skipping Mobile MCP device acceptance. "
      + "Set TAPHOUND_MOBILE_MCP_DEVICE=1 to opt in.\n"
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

try {
  await access(cli, constants.X_OK);
} catch {
  throw new Error("Build TapHound first with `npm run build`");
}

const server = spawnSync("mcp-server-mobile", ["--version"], {
  encoding: "utf8"
});
if (server.error !== undefined || server.status !== 0) {
  throw new Error(
    "mcp-server-mobile is not available on PATH.\n"
      + "Install the Mobile MCP server before running Mobile MCP acceptance."
  );
}

requireInstalledApp("dev.taphound.demo");

const requestedDevice = process.env.TAPHOUND_DEVICE;
const result = spawnSync(process.execPath, [
  cli,
  "doctor",
  "--project",
  projectRoot,
  "--json",
  ...(requestedDevice === undefined ? [] : ["--device", requestedDevice])
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    TAPHOUND_RUNTIME_BACKEND: "mobile-mcp"
  }
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

const lines = result.stdout.trim().split("\n");
if (lines.length !== 1) {
  throw new Error(
    `Expected exactly one JSON line from doctor --json, received ${
      String(lines.length)
    }`
  );
}
const report = JSON.parse(lines[0] ?? "");
if (report.runtimeBackend !== "mobile-mcp") {
  throw new Error(
    `Expected runtimeBackend "mobile-mcp", received "${String(report.runtimeBackend)}"`
  );
}
if (report.status !== "passed") {
  throw new Error("TapHound Mobile MCP device acceptance did not pass");
}
const checkNames = report.checks.map((check) => [
  check.name,
  check.status
]);
for (const [name, status] of [
  ["mobile-mcp", "passed"],
  ["app", "passed"],
  ["permissions", "passed"],
  ["device", "passed"]
]) {
  if (checkNames.some(([candidate, candidateStatus]) => (
    candidate === name && candidateStatus !== status
  ))) {
    throw new Error(
      `Expected doctor check "${name}" to pass under mobile-mcp, received ${
        JSON.stringify(report.checks)
      }`
    );
  }
}
process.stdout.write(
  `Mobile MCP device acceptance passed on ${String(report.deviceSerial)}\n`
);
