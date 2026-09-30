#!/usr/bin/env node
// Local proposed-step envelope helper for the taphound-journey-generator skill.
//
// Validates a `generation step --input` envelope offline (no device, no
// session) and auto-fills proposal.binding from a preceding observe/step
// output so baseRevision and snapshotHash never need hand-copying.
//
// The validation rules mirror schemas/proposed-step-envelope.json. When that
// schema changes, update this script and its test together.
import process from "node:process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sha256Pattern = /^[a-f\d]{64}$/;
const generationIdPattern = /^[A-Za-z\d](?:[A-Za-z\d._-]*[A-Za-z\d])?$/;
const qualifiedNamePattern = /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/;
const snapshotRefPattern
  = /^\.taphound\/build\/generations\/(?:\.[^/]+\.work|[^/]+)\/evidence\/snapshots\/revision-\d+\/[^/]+\/snapshot\.json$/;
const directions = new Set(["up", "down", "left", "right"]);
const logcatLevels = new Set(["V", "D", "I", "W", "E", "F", "A"]);
const logcatMatches = new Set(["literal", "regex"]);

const proposalShapes = new Map([
  ["click", {
    required: ["action", "locator", "binding", "activity"],
    optional: ["touchPolicy", "expect"]
  }],
  ["longClick", {
    required: ["action", "locator", "binding", "activity"],
    optional: ["touchPolicy", "durationMs", "expect"]
  }],
  ["inputText", {
    required: ["action", "text", "binding", "activity"],
    optional: ["expect"]
  }],
  ["swipe", {
    required: ["action", "locator", "direction", "binding", "activity"],
    optional: ["distancePercent", "durationMs", "expect"]
  }],
  ["scrollTo", {
    required: ["action", "locator", "container", "direction", "binding", "activity"],
    optional: ["maxSwipes", "distancePercent", "durationMs", "expect"]
  }],
  ["back", { required: ["action", "binding", "activity"], optional: ["expect"] }],
  ["wait", { required: ["action", "binding", "activity"], optional: ["expect"] }]
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(where, value, required, optional = [], subject = undefined) {
  if (!isPlainObject(value)) {
    fail("ENVELOPE_INVALID", `${where} must be a JSON object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const name = subject ?? where;
      fail(
        "ENVELOPE_INVALID",
        `${where}: unknown field "${key}"; ${name} allows fields: `
          + [...required, ...optional].join(", ")
      );
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      fail("ENVELOPE_INVALID", `${where}: missing required field "${key}"`);
    }
  }
}

function positiveInteger(where, value) {
  if (!Number.isInteger(value) || value < 1) {
    fail("ENVELOPE_INVALID", `${where} must be an integer >= 1`);
  }
}

function nonEmptyString(where, value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("ENVELOPE_INVALID", `${where} must be a non-empty string`);
  }
}

function validateQualifiedName(where, value) {
  if (typeof value !== "string" || !qualifiedNamePattern.test(value)) {
    fail(
      "ENVELOPE_INVALID",
      `${where} must be a dot-separated qualified name (for example com.example.app.MainActivity)`
    );
  }
}

function validateLocator(where, value) {
  exactKeys(
    where,
    value,
    [],
    ["resourceId", "text", "contentDescription", "index", "within", "evidence"],
    "locator"
  );
  if (
    value.resourceId === undefined
    && value.text === undefined
    && value.contentDescription === undefined
  ) {
    fail(
      "ENVELOPE_INVALID",
      `${where}: at least one of resourceId, text, or contentDescription is required`
    );
  }
  for (const key of ["resourceId", "text", "contentDescription"]) {
    if (value[key] !== undefined) {
      nonEmptyString(`${where}.${key}`, value[key]);
    }
  }
  if (value.index !== undefined) {
    if (!Number.isInteger(value.index) || value.index < 0) {
      fail("ENVELOPE_INVALID", `${where}.index must be an integer >= 0`);
    }
  }
  if (value.within !== undefined) {
    validateLocator(`${where}.within`, value.within);
  }
  if (value.evidence !== undefined) {
    exactKeys(`${where}.evidence`, value.evidence, ["version", "semanticSha256"]);
    if (value.evidence.version !== 1) {
      fail("ENVELOPE_INVALID", `${where}.evidence.version must be 1`);
    }
    if (
      typeof value.evidence.semanticSha256 !== "string"
      || !sha256Pattern.test(value.evidence.semanticSha256)
    ) {
      fail(
        "ENVELOPE_INVALID",
        `${where}.evidence.semanticSha256 must be a 64-character lowercase hex string`
      );
    }
    if (value.index === undefined) {
      fail(
        "ENVELOPE_INVALID",
        `${where}: evidence requires index (Core only binds evidence for indexed elements)`
      );
    }
  }
}

function validateBinding(where, value) {
  exactKeys(
    where, value, ["generationId", "baseRevision", "snapshotHash"], [],
    "binding"
  );
  if (
    typeof value.generationId !== "string"
    || !generationIdPattern.test(value.generationId)
  ) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.generationId must match ^[A-Za-z\\d](?:[A-Za-z\\d._-]*[A-Za-z\\d])?$`
    );
  }
  positiveInteger(`${where}.baseRevision`, value.baseRevision);
  if (
    typeof value.snapshotHash !== "string"
    || !sha256Pattern.test(value.snapshotHash)
  ) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.snapshotHash must be a 64-character lowercase hex string`
    );
  }
}

function validateActivity(where, value) {
  exactKeys(where, value, ["before"], [], "activity");
  validateQualifiedName(`${where}.before`, value.before);
}

function validateExpect(where, value) {
  if (!isPlainObject(value)) {
    fail("ENVELOPE_INVALID", `${where} must be a JSON object`);
  }
  if (value.type === "activity") {
    exactKeys(
      where, value, ["type", "value", "timeoutMs"], [],
      'expect.type "activity"'
    );
    validateQualifiedName(`${where}.value`, value.value);
    positiveInteger(`${where}.timeoutMs`, value.timeoutMs);
    return;
  }
  if (value.type === "element") {
    exactKeys(
      where,
      value,
      ["type", "locator", "timeoutMs"],
      ["enabled", "clickable", "absent"],
      'expect.type "element"'
    );
    validateLocator(`${where}.locator`, value.locator);
    for (const key of ["enabled", "clickable", "absent"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        fail("ENVELOPE_INVALID", `${where}.${key} must be a boolean`);
      }
    }
    if (value.absent === true
      && (value.enabled !== undefined || value.clickable !== undefined)) {
      fail(
        "ENVELOPE_INVALID",
        `${where}: absent: true cannot be combined with enabled or clickable`
      );
    }
    positiveInteger(`${where}.timeoutMs`, value.timeoutMs);
    return;
  }
  if (value.type === "logcat") {
    exactKeys(
      where, value, ["type", "tag", "pattern", "match", "timeoutMs"],
      ["level"], 'expect.type "logcat"'
    );
    nonEmptyString(`${where}.tag`, value.tag);
    nonEmptyString(`${where}.pattern`, value.pattern);
    if (!logcatMatches.has(value.match)) {
      fail("ENVELOPE_INVALID", `${where}.match must be "literal" or "regex"`);
    }
    if (value.level !== undefined && !logcatLevels.has(value.level)) {
      fail(
        "ENVELOPE_INVALID",
        `${where}.level must be one of V, D, I, W, E, F, A`
      );
    }
    positiveInteger(`${where}.timeoutMs`, value.timeoutMs);
    return;
  }
  fail(
    "ENVELOPE_INVALID",
    `${where}.type must be one of "activity", "element", or "logcat"`
  );
}

function validateProposal(where, value) {
  if (!isPlainObject(value)) {
    fail("ENVELOPE_INVALID", `${where} must be a JSON object`);
  }
  const shape = proposalShapes.get(value.action);
  if (shape === undefined) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.action must be one of ${[...proposalShapes.keys()].map((action) => `"${action}"`).join(", ")}`
    );
  }
  exactKeys(
    where, value, shape.required, shape.optional,
    `action "${String(value.action)}"`
  );
  if (value.locator !== undefined) {
    validateLocator(`${where}.locator`, value.locator);
  }
  if (value.container !== undefined) {
    validateLocator(`${where}.container`, value.container);
  }
  if (value.text !== undefined) {
    nonEmptyString(`${where}.text`, value.text);
  }
  if (value.direction !== undefined && !directions.has(value.direction)) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.direction must be one of "up", "down", "left", "right"`
    );
  }
  if (value.touchPolicy !== undefined) {
    if (value.touchPolicy !== "element") {
      fail("ENVELOPE_INVALID", `${where}.touchPolicy must be "element"`);
    }
    if (value.expect?.type !== "element" && value.expect?.type !== "activity") {
      fail(
        "ENVELOPE_INVALID",
        `${where}.touchPolicy "element" requires an element or activity expect that proves the touch took effect`
      );
    }
  }
  if (value.durationMs !== undefined) {
    positiveInteger(`${where}.durationMs`, value.durationMs);
  }
  if (value.maxSwipes !== undefined) {
    if (!Number.isInteger(value.maxSwipes)
      || value.maxSwipes < 1 || value.maxSwipes > 30) {
      fail("ENVELOPE_INVALID", `${where}.maxSwipes must be an integer 1..30`);
    }
  }
  if (value.distancePercent !== undefined) {
    if (typeof value.distancePercent !== "number"
      || !(value.distancePercent > 0 && value.distancePercent <= 1)) {
      fail(
        "ENVELOPE_INVALID",
        `${where}.distancePercent must be a number > 0 and <= 1`
      );
    }
  }
  validateBinding(`${where}.binding`, value.binding);
  validateActivity(`${where}.activity`, value.activity);
  if (value.expect !== undefined) {
    validateExpect(`${where}.expect`, value.expect);
  }
}

function validateSnapshotIdentity(where, snapshot, binding) {
  if (!isPlainObject(snapshot)) {
    fail("ENVELOPE_INVALID", `${where} must be a RuntimeSnapshot object`);
  }
  if (typeof snapshot.generationId !== "string"
    || snapshot.generationId.length === 0) {
    fail("ENVELOPE_INVALID", `${where}.generationId must be a non-empty string`);
  }
  if (!Number.isInteger(snapshot.baseRevision) || snapshot.baseRevision < 1) {
    fail("ENVELOPE_INVALID", `${where}.baseRevision must be an integer >= 1`);
  }
  if (snapshot.generationId !== binding.generationId) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.generationId does not match proposal.binding.generationId`
    );
  }
  if (snapshot.baseRevision !== binding.baseRevision) {
    fail(
      "ENVELOPE_INVALID",
      `${where}.baseRevision does not match proposal.binding.baseRevision`
    );
  }
}

function validateEnvelope(envelope) {
  exactKeys(
    "envelope",
    envelope,
    ["version", "proposal"],
    ["snapshot", "snapshotRef"]
  );
  if (envelope.version !== 1) {
    fail("ENVELOPE_INVALID", "envelope.version must be 1");
  }
  if (envelope.snapshot !== undefined && envelope.snapshotRef !== undefined) {
    fail(
      "ENVELOPE_INVALID",
      "envelope: exactly one of snapshot or snapshotRef is allowed, not both"
    );
  }
  if (envelope.snapshot === undefined && envelope.snapshotRef === undefined) {
    fail(
      "ENVELOPE_INVALID",
      "envelope: one of snapshot or snapshotRef is required"
    );
  }
  validateProposal("proposal", envelope.proposal);
  if (envelope.snapshotRef !== undefined
    && !snapshotRefPattern.test(envelope.snapshotRef)) {
    fail(
      "ENVELOPE_INVALID",
      "envelope.snapshotRef must be a Store-owned evidence reference returned by the preceding observe or step output"
    );
  }
  if (envelope.snapshot !== undefined) {
    validateSnapshotIdentity(
      "envelope.snapshot",
      envelope.snapshot,
      envelope.proposal.binding
    );
  }
  return {
    status: "valid",
    exitCode: 0,
    action: envelope.proposal.action,
    binding: envelope.proposal.binding,
    snapshotSource: envelope.snapshot === undefined ? "reference" : "inline"
  };
}

// A bind source is one observe output, one step output, or a raw binding
// object. The binding fields are copied verbatim; nothing is invented.
const BIND_SOURCE_HINT = "bind --from expects the unmodified stdout of "
  + "`taphound generation observe --json` (status \"observed\" with "
  + "generationId, baseRevision, snapshotHash, snapshotRef) or of a succeeded "
  + "`taphound generation step --json` (status \"succeeded\" with nextBinding "
  + "and nextSnapshotRef); save it with `> file` instead of assembling a "
  + "subset. A bare binding {generationId, baseRevision, snapshotHash} is also "
  + "accepted";

function readBindingFromSource(source) {
  if (!isPlainObject(source)) {
    fail("ENVELOPE_INVALID", "bind source must be a JSON object");
  }
  if (source.status === "observed") {
    validateBinding("observe output", {
      generationId: source.generationId,
      baseRevision: source.baseRevision,
      snapshotHash: source.snapshotHash
    });
    if (typeof source.snapshotRef !== "string"
      || !snapshotRefPattern.test(source.snapshotRef)) {
      fail(
        "ENVELOPE_INVALID",
        "observe output.snapshotRef is missing or not a Store-owned evidence reference"
      );
    }
    return {
      binding: {
        generationId: source.generationId,
        baseRevision: source.baseRevision,
        snapshotHash: source.snapshotHash
      },
      snapshotRef: source.snapshotRef
    };
  }
  if (source.status === "succeeded" && source.nextBinding !== undefined) {
    validateBinding("step output.nextBinding", source.nextBinding);
    if (typeof source.nextSnapshotRef !== "string"
      || !snapshotRefPattern.test(source.nextSnapshotRef)) {
      fail(
        "ENVELOPE_INVALID",
        "step output.nextSnapshotRef is missing or not a Store-owned evidence reference"
      );
    }
    return {
      binding: source.nextBinding,
      snapshotRef: source.nextSnapshotRef
    };
  }
  validateBinding("bind source", source);
  return {
    binding: {
      generationId: source.generationId,
      baseRevision: source.baseRevision,
      snapshotHash: source.snapshotHash
    },
    snapshotRef: typeof source.snapshotRef === "string"
      && snapshotRefPattern.test(source.snapshotRef)
      ? source.snapshotRef
      : undefined
  };
}

async function readJsonFile(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail(
      "ENVELOPE_IO",
      `Unable to read ${label} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      "ENVELOPE_INVALID",
      `${label} at ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// The Activity the bound snapshot was captured on, taken from the bind source
// (full observe/step output), the inline envelope snapshot, or the
// Store-owned snapshot file under the project root. Undefined when none of
// them is readable; Core still enforces the check on `generation step`.
async function boundSnapshotActivity(source, envelope, snapshotRef, projectRoot) {
  const inline = [
    ["bind source snapshot", source.snapshot],
    ["bind source nextSnapshot", source.nextSnapshot],
    ["envelope.snapshot", envelope.snapshot]
  ];
  for (const [from, snapshot] of inline) {
    if (isPlainObject(snapshot) && typeof snapshot.activity === "string") {
      return { activity: snapshot.activity, from };
    }
  }
  const ref = envelope.snapshotRef ?? snapshotRef;
  if (typeof ref !== "string" || !snapshotRefPattern.test(ref)) {
    return undefined;
  }
  try {
    const snapshot = JSON.parse(await readFile(join(projectRoot, ref), "utf8"));
    return isPlainObject(snapshot) && typeof snapshot.activity === "string"
      ? { activity: snapshot.activity, from: ref }
      : undefined;
  } catch {
    return undefined;
  }
}

async function bind(inputPath, fromPath, outPath, projectRoot) {
  const envelope = await readJsonFile(inputPath, "envelope input");
  exactKeys(
    "envelope input",
    envelope,
    ["version", "proposal"],
    ["snapshot", "snapshotRef"]
  );
  if (envelope.version !== 1) {
    fail("ENVELOPE_INVALID", "envelope.version must be 1");
  }
  const source = await readJsonFile(fromPath, "bind source");
  let bindingSource;
  try {
    bindingSource = readBindingFromSource(source);
  } catch (error) {
    if (error?.code === "ENVELOPE_INVALID") {
      fail("ENVELOPE_INVALID", `${error.message}. ${BIND_SOURCE_HINT}`);
    }
    throw error;
  }
  const { binding, snapshotRef } = bindingSource;
  const proposal = isPlainObject(envelope.proposal)
    ? { ...envelope.proposal, binding }
    : undefined;
  if (proposal === undefined) {
    fail("ENVELOPE_INVALID", "envelope.proposal must be a JSON object");
  }
  const bound = {
    version: 1,
    proposal,
    ...(envelope.snapshot === undefined
      ? envelope.snapshotRef === undefined && snapshotRef !== undefined
        ? { snapshotRef }
        : {}
      : { snapshot: envelope.snapshot })
  };
  validateEnvelope(bound);
  const snapshotActivity = await boundSnapshotActivity(
    source,
    bound,
    snapshotRef,
    projectRoot
  );
  const before = proposal.activity?.before;
  if (snapshotActivity !== undefined && before !== snapshotActivity.activity) {
    fail(
      "ENVELOPE_ACTIVITY_MISMATCH",
      `proposal.activity.before ${String(before)} does not match the bound snapshot Activity ${
        snapshotActivity.activity
      } (from ${snapshotActivity.from}); set activity.before to ${
        snapshotActivity.activity
      }`
    );
  }
  if (outPath !== undefined) {
    const absolute = resolve(outPath);
    await mkdir(dirname(absolute), { recursive: true });
    const temp = `${absolute}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(bound, null, 2)}\n`);
    await rename(temp, absolute);
    process.stdout.write(`${JSON.stringify({
      status: "bound",
      exitCode: 0,
      path: outPath,
      binding,
      ...(snapshotRef === undefined ? {} : { snapshotRef }),
      activityCheck: snapshotActivity === undefined ? "unverified" : "matched"
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(bound)}\n`);
}

function options(argv, names) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.includes(name) || value === undefined) {
      fail("ENVELOPE_USAGE", `Invalid option ${String(name)}`);
    }
    result[name.slice(2)] = value;
  }
  return result;
}

function help() {
  return [
    "TapHound Proposed Step Envelope Helper",
    "",
    "Commands:",
    "  validate --input <envelope.json>",
    "      Validate one generation step envelope offline (no device, no session).",
    "  bind --input <envelope.json> --from <observe-or-step-output.json> [--out <path>] [--project <root>]",
    "      Fill proposal.binding (and snapshotRef when absent) from the preceding",
    "      observe output, step output, or raw binding, then validate.",
    "      It also checks proposal.activity.before against the bound snapshot's",
    "      Activity (from the full output, the inline snapshot, or the snapshot",
    "      file under --project, default the current directory) and fails with",
    "      ENVELOPE_ACTIVITY_MISMATCH naming the snapshot Activity. With --out,",
    "      activityCheck reports \"matched\" or \"unverified\" (no readable snapshot).",
    "",
    "bind writes the bound envelope to --out; without --out the bound envelope",
    "itself is the single stdout JSON value.",
    "",
    "Revision rule: observe advances the session revision by 1. A succeeded",
    "step advances it by 2 for the step plus 1 for the post-action observation",
    "behind nextBinding, so consecutive steps are 3 apart. Never compute",
    "revisions: bind from the latest observe or step output."
  ].join("\n");
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (command === "validate") {
    const input = options(argv, ["--input"]);
    const envelope = await readJsonFile(input.input, "envelope input");
    process.stdout.write(`${JSON.stringify(validateEnvelope(envelope))}\n`);
    return;
  }
  if (command === "bind") {
    const input = options(argv, ["--input", "--from", "--out", "--project"]);
    if (input.input === undefined || input.from === undefined) {
      fail("ENVELOPE_USAGE", "bind requires --input and --from");
    }
    await bind(input.input, input.from, input.out, resolve(input.project ?? "."));
    return;
  }
  fail("ENVELOPE_USAGE", `Unknown command ${command}`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "ENVELOPE_INTERNAL",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 2;
});
