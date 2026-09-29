#!/usr/bin/env node
// Redact and pack TapHound generation evidence for a feedback report.
// Standalone: needs only Node.js and `tar`, not a TapHound checkout.
//
// Usage (run from the Android project root, or pass --project):
//   node feedback-pack.mjs [--project <root>] [--package <pkg>]
//     [--generation <id>]... [--run <runId>]... [--out <file.tgz>]
//
// Unlike `taphound diagnose export` (allowlisted counters, no evidence), this
// keeps step timing, idle telemetry, and full layout snapshots, which is what
// timing and screen-state problems need. See docs/diagnostics.md.
//
// Collects every JSON file under .taphound/build/generations/<id>/ (including
// active .<id>.work bundles) and, optionally, .taphound/build/runs/<runId>/
// report.json. Screenshots, Logcat text, and other non-JSON files are never
// copied. Package, Activity/class names, resource ids, UI text, Logcat
// tags/patterns, device serials, and absolute paths are replaced by stable
// pseudonyms. The pseudonym mapping is written next to the archive, never
// inside it, so you can translate references back.

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const HELP = `Usage: node feedback-pack.mjs [options]

  --project <root>     Android project root (default: current directory)
  --package <pkg>      App package (default: run.packageName in .taphound/config.json)
  --org-prefix <pfx>   Extra class-name prefix to redact, e.g. com.acme (repeatable)
  --generation <id>    Only this generation id (repeatable; default: all)
  --run <runId>        Also include .taphound/build/runs/<runId>/report.json (repeatable)
  --out <file>         Archive path (default: .taphound/build/diagnostics/
                       taphound-feedback-<timestamp>.tgz)
  --help               Show this help
`;

// Keys whose string values are free UI/business text.
const TEXT_KEYS = new Set([
  "text", "contentDescription", "hint", "title", "label", "tooltipText",
  "pattern", "tag", "event", "literal", "inputText"
]);
// Keys whose whole subtree holds business values.
const VALUE_TREE_KEYS = new Set(["fields", "values", "captures", "bindings"]);
const SERIAL_KEYS = new Set(["deviceSerial", "serial", "device"]);
// Keys holding diagnostic sentences that may quote UI text.
const FREE_TEXT_KEYS = new Set([
  "message", "reason", "detail", "details", "error", "summary", "diagnostic",
  "description", "remediation", "stderr", "stdout", "hint"
]);
// Packages kept verbatim: they describe the platform, not the app.
const PUBLIC_PREFIXES = [
  "android.", "androidx.", "com.android.", "com.google.android.", "java.",
  "kotlin.", "dalvik.", "io.appium.", "com.github.uiautomator"
];

const QUALIFIED = /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/;
const RESOURCE_ID = /^([A-Za-z_][\w.]*):(id|string|drawable|layout)\/(.+)$/;
const HEX_HASH = /^[a-f\d]{40,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

function parseArgs(argv) {
  const options = {
    project: process.cwd(), package: undefined, orgPrefixes: [],
    generations: [], runs: [], out: undefined, help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--project": options.project = value(); break;
      case "--package": options.package = value(); break;
      case "--org-prefix": options.orgPrefixes.push(value()); break;
      case "--generation": options.generations.push(value()); break;
      case "--run": options.runs.push(value()); break;
      case "--out": options.out = value(); break;
      case "--help": case "-h": options.help = true; break;
      default: fail(`Unknown option ${flag}\n\n${HELP}`);
    }
  }
  options.project = resolve(options.project);
  return options;
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readPackage(projectRoot) {
  const configPath = join(projectRoot, ".taphound", "config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"))?.run?.packageName;
  } catch {
    return undefined;
  }
}

function listJsonFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      // Skip macOS AppleDouble "._*" companions of copied files.
      else if (entry.isFile() && entry.name.endsWith(".json")
        && !entry.name.startsWith("._")) files.push(path);
    }
  };
  walk(directory);
  return files.sort();
}

function collectSources(options) {
  const buildRoot = join(options.project, ".taphound", "build");
  const generationsRoot = join(buildRoot, "generations");
  if (!existsSync(generationsRoot)) {
    fail(`No generations directory at ${generationsRoot}`);
  }
  const wanted = new Set(options.generations);
  const bundles = readdirSync(generationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".locks")
    .filter((entry) => {
      const id = entry.name.replace(/^\.(.+)\.work$/, "$1");
      return wanted.size === 0 || wanted.has(id);
    })
    .map((entry) => join(generationsRoot, entry.name));
  if (bundles.length === 0) fail("No matching generation bundles found");

  const files = bundles.flatMap(listJsonFiles);
  for (const runId of options.runs) {
    const report = join(buildRoot, "runs", runId, "report.json");
    if (!existsSync(report)) fail(`Run report not found: ${report}`);
    files.push(report);
    const verdict = join(buildRoot, "runs", runId, "verdict.json");
    if (existsSync(verdict)) files.push(verdict);
  }
  return { files, bundles };
}

class Redactor {
  constructor({ packageName, orgPrefixes, projectRoot }) {
    this.appPackage = packageName;
    this.prefixes = [...new Set([
      packageName,
      packageName.split(".").slice(0, 2).join("."),
      ...orgPrefixes
    ])].filter((prefix) => prefix.includes("."));
    this.paths = [[projectRoot, "<project>"], [homedir(), "~"]]
      .filter(([path]) => path.length > 1);
    this.maps = {
      package: new Map([[packageName, "com.example.app"]]),
      class: new Map(),
      resource: new Map(),
      text: new Map(),
      resourceName: new Map(),
      serial: new Map()
    };
  }

  isPrivateName(value) {
    if (PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
    return this.prefixes.some(
      (prefix) => value === prefix || value.startsWith(`${prefix}.`)
    );
  }

  pseudo(kind, value, make) {
    const map = this.maps[kind];
    if (!map.has(value)) map.set(value, make(map.size + 1));
    return map.get(value);
  }

  packageFor(value) {
    if (this.maps.package.has(value)) return this.maps.package.get(value);
    if (value.startsWith(`${this.appPackage}.`)) return undefined;
    return this.pseudo("package", value, (n) => `com.example.other${n}`);
  }

  classFor(value) {
    if (this.maps.package.has(value)) return this.maps.package.get(value);
    return this.pseudo("class", value, (n) => {
      const last = value.split(".").at(-1) ?? "";
      const kind = /Activity$/.test(last) ? "Activity"
        : /Fragment$/.test(last) ? "Fragment" : "Class";
      return `com.example.app.${kind}${n}`;
    });
  }

  // Pass 1: learn every sensitive value.
  learn(value, key, inValueTree) {
    if (Array.isArray(value)) {
      for (const item of value) this.learn(item, key, inValueTree);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        this.learn(child, childKey, inValueTree || VALUE_TREE_KEYS.has(childKey));
      }
      return;
    }
    if (typeof value !== "string" || value.length === 0) return;
    if (SERIAL_KEYS.has(key) && !QUALIFIED.test(value)) {
      this.pseudo("serial", value, (n) => `device-${n}`);
      return;
    }
    if (key === "resourceId" && !value.includes(":")) {
      // Some UI backends report bare resource names (e.g. "btn_submit").
      this.pseudo("resourceName", value, (n) => `r${n}`);
      return;
    }
    const resource = RESOURCE_ID.exec(value);
    if (resource !== null) {
      const [, owner, type] = resource;
      if (owner !== "android" && !PUBLIC_PREFIXES.some((p) => `${owner}.`.startsWith(p))) {
        this.pseudo("resource", value, (n) => {
          const pkg = owner === this.appPackage ? "com.example.app" : "com.example.other";
          return `${pkg}:${type}/r${n}`;
        });
      }
      return;
    }
    if (QUALIFIED.test(value) && this.isPrivateName(value)) {
      if (key.toLowerCase().includes("package")) this.packageFor(value);
      else this.classFor(value);
      return;
    }
    if (TEXT_KEYS.has(key) || inValueTree) {
      if (HEX_HASH.test(value) || ISO_DATE.test(value)) return;
      this.pseudo("text", value, (n) => `T${n}`);
    }
  }

  finish() {
    // Longest originals first so a substring never shadows its container.
    const byLength = (a, b) => b[0].length - a[0].length;
    const names = [...this.paths];
    for (const kind of ["serial", "resource", "class", "package"]) {
      for (const pair of this.maps[kind]) names.push(pair);
    }
    this.nameSubstrings = names.sort(byLength);
    this.textSubstrings = [...this.maps.text, ...this.maps.resourceName]
      .filter(([original]) => original.length >= 3)
      .sort(byLength);
    this.exactNames = new Map(names);
  }

  // Pass 2: rewrite values. Keys stay verbatim so the schema remains readable.
  rewrite(value, key = "", inValueTree = false) {
    if (Array.isArray(value)) {
      return value.map((item) => this.rewrite(item, key, inValueTree));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        this.rewrite(child, childKey, inValueTree || VALUE_TREE_KEYS.has(childKey))
      ]));
    }
    if (typeof value !== "string") return value;
    if (this.exactNames.has(value)) return this.exactNames.get(value);
    if (key === "resourceId" && this.maps.resourceName.has(value)) {
      return this.maps.resourceName.get(value);
    }
    if ((TEXT_KEYS.has(key) || inValueTree) && this.maps.text.has(value)) {
      return this.maps.text.get(value);
    }
    const withNames = this.rewriteString(value, this.nameSubstrings);
    return FREE_TEXT_KEYS.has(key)
      ? this.rewriteString(withNames, this.textSubstrings)
      : withNames;
  }

  rewriteString(value, pairs = this.nameSubstrings) {
    // Placeholders keep one replacement's output from matching another original.
    let result = value;
    const pending = [];
    for (const [original, replacement] of pairs) {
      if (!result.includes(original)) continue;
      const token = `\u0000${pending.length}\u0000`;
      result = result.split(original).join(token);
      pending.push([token, replacement]);
    }
    for (const [token, replacement] of pending) {
      result = result.split(token).join(replacement);
    }
    return result;
  }

  mapping() {
    return Object.fromEntries(Object.entries(this.maps).map(
      ([kind, map]) => [kind, Object.fromEntries(
        [...map].map(([original, replacement]) => [replacement, original])
      )]
    ));
  }

  counts() {
    return Object.fromEntries(Object.entries(this.maps).map(
      ([kind, map]) => [kind, map.size]
    ));
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const packageName = options.package ?? readPackage(options.project);
  if (typeof packageName !== "string" || !QUALIFIED.test(packageName)) {
    fail("Cannot determine the app package; pass --package <pkg>");
  }
  const { files, bundles } = collectSources(options);
  const redactor = new Redactor({
    packageName, orgPrefixes: options.orgPrefixes, projectRoot: options.project
  });

  const documents = [];
  for (const file of files) {
    try {
      documents.push([file, JSON.parse(readFileSync(file, "utf8"))]);
    } catch {
      process.stderr.write(`skip (not valid JSON): ${relative(options.project, file)}\n`);
    }
  }
  for (const [, document] of documents) redactor.learn(document, "", false);
  redactor.finish();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // The diagnostics directory sits in the Git-ignored build subtree.
  const out = resolve(options.out ?? join(
    options.project, ".taphound", "build", "diagnostics",
    `taphound-feedback-${stamp}.tgz`
  ));
  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "taphound-feedback-"));
  const root = join(staging, "taphound-feedback");
  try {
    for (const [file, document] of documents) {
      const relativePath = redactor.rewriteString(
        relative(options.project, file).split(sep).join("/")
      );
      const target = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(redactor.rewrite(document), null, 2)}\n`);
    }
    writeFileSync(join(root, "README.txt"), [
      "TapHound feedback bundle (redacted).",
      `Generation bundles: ${bundles.length}`,
      `JSON files: ${documents.length}`,
      `Pseudonyms: ${JSON.stringify(redactor.counts())}`,
      "Screenshots, Logcat text, and non-JSON files are excluded.",
      ""
    ].join("\n"));

    const tar = spawnSync(
      "tar", ["-czf", out, "-C", staging, "taphound-feedback"],
      {
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
        // Stop macOS bsdtar from adding AppleDouble "._*" xattr entries.
        env: { ...process.env, COPYFILE_DISABLE: "1" }
      }
    );
    if (tar.error !== undefined || tar.status !== 0) {
      fail(`tar failed${tar.error ? `: ${tar.error.message}` : ""}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const mappingPath = out.replace(/\.t(?:ar\.)?gz$/, "") + ".mapping.json";
  writeFileSync(mappingPath, `${JSON.stringify(redactor.mapping(), null, 2)}\n`);

  process.stdout.write([
    `Archive:  ${out} (${statSync(out).size} bytes)`,
    `Mapping:  ${mappingPath}  <- keep this local, do NOT share`,
    `Bundles:  ${bundles.map((bundle) => basename(bundle)).join(", ")}`,
    `Files:    ${documents.length} JSON`,
    `Redacted: ${JSON.stringify(redactor.counts())}`,
    "Review:   tar -xzf <archive> and grep for anything still sensitive before sharing.",
    ""
  ].join("\n"));
}

main();
