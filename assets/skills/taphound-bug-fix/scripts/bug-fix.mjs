#!/usr/bin/env node
// taphound-bug-fix helper: zero-dependency, prints one JSON value to stdout.
//
//   node bug-fix.mjs reader get
//   node bug-fix.mjs reader set <skill-name>
//   node bug-fix.mjs reader reset
//   node bug-fix.mjs crash parse <file> [--package <name>]
//   node bug-fix.mjs crash match <reported-file> <observed-file> [--package <name>]
//
// Exit codes: 0 ok (or crashes match), 1 crashes do not match,
// 2 usage or invalid input, 3 environment (user config not writable).
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_READER_SKILL = "bug-tracker-reader";
const READER_ENV = "TAPHOUND_BUG_READER_SKILL";
const CONFIG_DIR_ENV = "TAPHOUND_USER_CONFIG_DIR";
const CONFIG_FILE = "bug-fix.json";
// A Skill name, optionally namespaced by its plugin (`plugin:skill`).
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?$/;
const MAX_MESSAGE = 200;
const MAX_FRAMES = 20;

class BugFixError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 2) {
  throw new BugFixError(code, message, exitCode);
}

const HELP = `taphound-bug-fix helper

  reader get                    Print the bug-tracker reader Skill to load
  reader set <skill-name>       Save your reader Skill (per user, not per project)
  reader reset                  Forget the saved reader Skill
  crash parse <file>            Normalize a crash (Java/Kotlin, ANR, native)
  crash match <reported> <observed>
                                Compare two crashes by kind, root exception
                                type, and first app frame

Options:
  --package <name>              App package whose frames count as app frames
                                (defaults to the crash's "Process:" line)

Reader resolution order: ${READER_ENV}, the saved user setting, then
"${DEFAULT_READER_SKILL}". The setting lives in
$${CONFIG_DIR_ENV}, $XDG_CONFIG_HOME/taphound, or ~/.config/taphound
(%APPDATA%\\taphound on Windows), never in the project.
`;

// ---------------------------------------------------------------- reader

function configDirectory(env = process.env) {
  if (env[CONFIG_DIR_ENV]) return env[CONFIG_DIR_ENV];
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "taphound");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "taphound");
  }
  return join(homedir(), ".config", "taphound");
}

function configPath(env = process.env) {
  return join(configDirectory(env), CONFIG_FILE);
}

function validSkillName(name, where) {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    fail(
      "READER_INVALID",
      `${where} must be a Skill name (lowercase letters, digits, hyphens; optionally plugin:skill)`
    );
  }
  return name;
}

async function savedReader(env = process.env) {
  let text;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("READER_CONFIG_UNREADABLE", `Cannot read ${configPath(env)}: ${error.message}`, 3);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("READER_CONFIG_INVALID", `${configPath(env)} is not valid JSON; run "reader reset"`);
  }
  if (value?.version !== 1) {
    fail("READER_CONFIG_INVALID", `${configPath(env)} has an unknown version; run "reader reset"`);
  }
  return validSkillName(value.readerSkill, `${configPath(env)} readerSkill`);
}

export async function resolveReader(env = process.env) {
  if (env[READER_ENV]) {
    return {
      readerSkill: validSkillName(env[READER_ENV], READER_ENV),
      source: "env"
    };
  }
  const saved = await savedReader(env);
  return saved === undefined
    ? { readerSkill: DEFAULT_READER_SKILL, source: "default" }
    : { readerSkill: saved, source: "userConfig" };
}

async function readerCommand(args) {
  const [action, name, ...rest] = args;
  if (action === "get" && name === undefined) {
    return { status: "ok", ...(await resolveReader()), configPath: configPath() };
  }
  if (action === "set" && name !== undefined && rest.length === 0) {
    const readerSkill = validSkillName(name, "skill-name");
    const path = configPath();
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 1, readerSkill }, null, 2)}\n`);
    } catch (error) {
      fail("READER_CONFIG_UNWRITABLE", `Cannot write ${path}: ${error.message}`, 3);
    }
    return {
      status: "saved",
      readerSkill,
      configPath: path,
      ...(process.env[READER_ENV]
        ? { note: `${READER_ENV} is set and still takes precedence` }
        : {})
    };
  }
  if (action === "reset" && name === undefined) {
    await rm(configPath(), { force: true });
    return { status: "reset", ...(await resolveReader()), configPath: configPath() };
  }
  fail("USAGE", "reader expects: get | set <skill-name> | reset");
}

// ----------------------------------------------------------------- crash

const LOGCAT_PREFIXES = [
  // threadtime: 10-09 12:00:00.123  1234  1234 E AndroidRuntime: ...
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEFA]\s+[^:]*?:\s?/,
  // brief / tag: E/AndroidRuntime( 1234): ...
  /^[VDIWEFA]\/[^(:]*(?:\(\s*\d+\))?:\s?/,
  // E AndroidRuntime: ...
  /^[VDIWEFA]\s+[\w.$-]+\s*:\s/
];

function payload(line) {
  for (const prefix of LOGCAT_PREFIXES) {
    const match = prefix.exec(line);
    if (match) return line.slice(match[0].length);
  }
  return line;
}

const THROWABLE = /^((?:[A-Za-z_$][\w$]*\.)+[A-Z][\w$]*)(?::\s?(.*))?$/;
const FRAME = /^\s*at\s+((?:[\w$<>-]+\.)*[\w$<>-]+)\.([\w$<>-]+)\(([^)]*)\)/;

function truncate(text) {
  if (text === undefined || text === "") return undefined;
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

function parseJavaCrash(lines) {
  const fatalIndex = lines.findIndex((line) => /FATAL EXCEPTION:/.test(line));
  const start = fatalIndex === -1
    ? lines.findIndex((line, index) => THROWABLE.test(line.trim())
        && FRAME.test(lines[index + 1] ?? ""))
    : fatalIndex;
  if (start === -1) return undefined;
  const thread = fatalIndex === -1
    ? undefined
    : /FATAL EXCEPTION:\s*(.+)$/.exec(lines[fatalIndex])?.[1]?.trim();
  let processName;
  const chain = [];
  for (const raw of lines.slice(start + (fatalIndex === -1 ? 0 : 1))) {
    const line = raw.trim();
    const processMatch = /^Process:\s*([\w.:]+)/.exec(line);
    if (processMatch) {
      processName = processMatch[1];
      continue;
    }
    const frame = FRAME.exec(raw);
    if (frame) {
      const current = chain.at(-1);
      if (current && current.frames.length < MAX_FRAMES) {
        current.frames.push({
          className: frame[1],
          method: frame[2],
          location: frame[3]
        });
      }
      continue;
    }
    if (/^\.\.\.\s*\d+\s+more$/.test(line) || line === "") continue;
    const cause = line.startsWith("Caused by: ") ? line.slice(11) : undefined;
    const throwable = THROWABLE.exec(cause ?? line);
    if (throwable && (cause !== undefined || chain.length === 0)) {
      chain.push({
        type: throwable[1],
        ...(truncate(throwable[2]) === undefined ? {} : { message: truncate(throwable[2]) }),
        frames: []
      });
      continue;
    }
    if (chain.length > 0 && !line.startsWith("Suppressed:")) break;
  }
  if (chain.length === 0) return undefined;
  return {
    kind: "java",
    ...(thread === undefined ? {} : { thread }),
    ...(processName === undefined ? {} : { processName }),
    chain
  };
}

function parseAnr(lines) {
  const index = lines.findIndex((line) => /ANR in\s+[\w.:]+/.test(line));
  if (index === -1) return undefined;
  const processName = /ANR in\s+([\w.:]+)/.exec(lines[index])[1];
  const reason = lines.slice(index, index + 10)
    .map((line) => /Reason:\s*(.+)$/.exec(line)?.[1])
    .find((value) => value !== undefined);
  return {
    kind: "anr",
    processName,
    ...(truncate(reason) === undefined ? {} : { reason: truncate(reason) }),
    chain: []
  };
}

function parseNative(lines) {
  const index = lines.findIndex((line) => /signal\s+\d+\s+\(SIG[A-Z]+\)/.test(line));
  if (index === -1) return undefined;
  const signal = /signal\s+\d+\s+\((SIG[A-Z]+)\)/.exec(lines[index])[1];
  const processName = lines.slice(Math.max(0, index - 5), index + 1)
    .map((line) => />>>\s*([\w.:]+)\s*<<</.exec(line)?.[1])
    .find((value) => value !== undefined);
  const frames = [];
  for (const line of lines.slice(index)) {
    const frame = /#\d+\s+pc\s+[0-9a-f]+\s+(\S+)(?:\s+\(([^)+]+))?/.exec(line);
    if (frame && frames.length < MAX_FRAMES) {
      frames.push({ className: frame[1], method: frame[2] ?? "?", location: "" });
    }
  }
  return {
    kind: "native",
    signal,
    ...(processName === undefined ? {} : { processName }),
    chain: [{ type: signal, frames }]
  };
}

function appFrame(frames, packageName) {
  if (packageName === undefined) return undefined;
  const prefix = `${packageName.split(":")[0]}.`;
  return frames.find((frame) => frame.className.startsWith(prefix));
}

export function parseCrash(text, options = {}) {
  const lines = text.split(/\r?\n/).map(payload);
  const crash = parseJavaCrash(lines) ?? parseAnr(lines) ?? parseNative(lines);
  if (crash === undefined) {
    fail(
      "CRASH_NOT_FOUND",
      "No Java/Kotlin exception, ANR, or native signal found in the input"
    );
  }
  const packageName = options.packageName ?? crash.processName;
  const root = crash.chain.at(-1);
  const rootType = crash.kind === "anr" ? "ANR" : root.type;
  // The first app frame of the root cause, else of any cause, else the top frame.
  const frame = root === undefined
    ? undefined
    : appFrame(root.frames, packageName)
      ?? crash.chain.map((cause) => appFrame(cause.frames, packageName))
        .find((found) => found !== undefined)
      ?? root.frames[0];
  const topFrame = frame === undefined ? undefined : `${frame.className}.${frame.method}`;
  const signature = `${crash.kind}:${rootType}@${topFrame ?? "-"}`;
  return {
    ...crash,
    ...(packageName === undefined ? {} : { packageName }),
    rootCause: rootType,
    ...(topFrame === undefined ? {} : { topAppFrame: topFrame }),
    ...(frame?.location ? { topAppFrameLocation: frame.location } : {}),
    signature,
    signatureSha256: createHash("sha256").update(signature).digest("hex").slice(0, 16)
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return { value: undefined, rest: args };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail("USAGE", `${name} needs a value`);
  }
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

async function readInput(path) {
  if (path === undefined) fail("USAGE", "crash commands take file paths");
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail("INPUT_UNREADABLE", `Cannot read ${path}: ${error.message}`);
  }
}

async function crashCommand(args) {
  const { value: packageName, rest } = option(args, "--package");
  const [action, ...files] = rest;
  const options = packageName === undefined ? {} : { packageName };
  if (action === "parse" && files.length === 1) {
    return { status: "parsed", crash: parseCrash(await readInput(files[0]), options) };
  }
  if (action === "match" && files.length === 2) {
    const reported = parseCrash(await readInput(files[0]), options);
    const observed = parseCrash(await readInput(files[1]), options);
    const differences = [];
    if (reported.kind !== observed.kind) differences.push("kind");
    if (reported.rootCause !== observed.rootCause) differences.push("rootCause");
    if (reported.topAppFrame !== observed.topAppFrame) differences.push("topAppFrame");
    return {
      status: differences.length === 0 ? "matched" : "mismatched",
      exitCode: differences.length === 0 ? 0 : 1,
      differences,
      reported: summary(reported),
      observed: summary(observed)
    };
  }
  fail("USAGE", "crash expects: parse <file> | match <reported> <observed>");
}

function summary(crash) {
  return {
    kind: crash.kind,
    rootCause: crash.rootCause,
    ...(crash.topAppFrame === undefined ? {} : { topAppFrame: crash.topAppFrame }),
    signature: crash.signature
  };
}

// ------------------------------------------------------------------ main

async function main(argv) {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  let result;
  try {
    if (command === "reader") result = await readerCommand(args);
    else if (command === "crash") result = await crashCommand(args);
    else fail("USAGE", `Unknown command "${command}"; run "help"`);
  } catch (error) {
    const known = error instanceof BugFixError;
    const exitCode = known ? error.exitCode : 2;
    process.stdout.write(`${JSON.stringify({
      status: "error",
      exitCode,
      code: known ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error)
    })}\n`);
    return exitCode;
  }
  const exitCode = result.exitCode ?? 0;
  process.stdout.write(`${JSON.stringify({ ...result, exitCode })}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
