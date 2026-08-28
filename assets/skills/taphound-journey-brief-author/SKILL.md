---
name: taphound-journey-brief-author
description: >-
  Author and maintain the TapHound Project Context Bundle and author one
  Journey Brief per Case. Ensures a valid Context (generate, refresh,
  rehash, validate) before combining Android source analysis with read-only
  device observation into a taphound-journey-brief.md, ready for the
  taphound-journey-generator skill to consume. Use when the user wants to
  generate, refresh, or regenerate the Project Context, initialize project
  context, create a journey brief, or prepare case context before journey
  generation.
compatibility: >-
  Requires Node.js 22+, Android SDK with ADB and uiautomator, and TapHound
  built and linked. Context-only runs need no device; Brief authoring
  prefers one online Android device.
metadata:
  author: TapHound
  version: "2.0"
---

# TapHound Journey Brief Author Skill

This Skill is the single read-only **producer** of the two pre-Journey
artifacts:

1. **Project Context Bundle** (project-wide, cached, reused by every
   Case) — generated once, refreshed after source changes, and persisted
   under `.taphound/context/`. It describes the project's modules,
   Activities, UI elements, navigation transitions, and interaction policy.
2. **Journey Brief** (one per Case) — the untrusted static handoff from
   the planning phase to the Journey generation phase. It reduces broad
   source rediscovery but never weakens Core validation, live Snapshot
   binding, risk policy, or final Replay.

The `taphound-journey-generator` skill is the **consumer** of both. It requires a
valid Context and never generates or repairs it; when it encounters a stale
or invalid Context, it stops and requires this Skill to run first. The Brief
is handed over through a `{path, sha256}` binding.

Core does all Context structural bookkeeping: module discovery, identity
inspection (`packageName`, `launchActivity`), evidence and inventory
hashing, and atomic writes. The agent's job is to fill in semantic `summary`
fields that Core cannot infer from source alone, then combine them with
Case analysis into the Brief.

## Skill Directory

All file references are relative to `assets/skills/taphound-journey-brief-author/`.
The directory contains:

- `prompts/brief-author-role.md` (+ zh-CN) — the lean subagent bootstrap prompt
- `prompts/context-analyze-project.md` — module-by-module semantic analysis guidance
- `schemas/` — JSON Schemas for the Context index, module shards, and refresh result
- `templates/` — the Brief skeleton and example Context files
- `CONTEXT-GUIDE.md` — detailed end-to-end Context usage guide

Read `prompts/context-analyze-project.md`, the relevant Context schema, and
`CONTEXT-GUIDE.md` before performing any Context ensure work (Phase 0
branches L1–L3). The normal per-Case happy path (Context valid) does not
need them.

## How to Use This Skill

Run `taphound init --agent <ids>` to install. The Skill is installed alongside
`taphound-journey-generator` into each agent's skills directory.

### Two consumption modes

1. **Subagent dispatch (primary)**: Copy the full content of
   `prompts/brief-author-role.md` into the subagent's PROMPT configuration
   field. The orchestrator dispatches one task per Case with explicit
   inputs (see Inputs below). The subagent returns a structured JSON
   summary; the orchestrator never re-parses raw exploration content.

2. **Manual single-Case**: An agent loads this SKILL.md directly, follows
   the phases below, and produces one Brief.

### Relationship to the Journey Skill

```
Orchestrator (lean context)
  |
  ├── dispatches brief-author subagent
  |     inputs: {project, caseGoal, caseId?, contextPaths?, observeSnapshot?, contextOnly?}
  |     output: {path, sha256, caseId, edgesVerified, edgesNeedsObservation}
  |            (contextOnly runs return the Context summary instead)
  |
  ├── human Review (brief is an inspectable artifact)
  |
  └── dispatches journey subagent
        inputs: {project, goal, journeyBrief: {path, sha256}}
        output: {journeyPath, reportPath, verified}
```

## Inputs

| Parameter       | Required | Default                                          | Description                                      |
|-----------------|----------|--------------------------------------------------|--------------------------------------------------|
| project         | yes      | —                                                | Android project root path                        |
| caseGoal        | yes      | —                                                | One Case's test scenario (ignored when `contextOnly`) |
| caseId          | no       | —                                                | Case identifier for frontmatter                  |
| contextPaths    | no       | —                                                | Explicit path array; orchestrator decides which docs |
| context         | no       | `.taphound/context/project-context.json`         | Project Context path (relative to project)       |
| contextOnly     | no       | `false`                                          | Run only the Context lifecycle (ensure/refresh/regenerate); skip Brief authoring |
| observeSnapshot | no       | —                                                | Pre-captured `taphound observe --json` result    |
| device          | no       | doctor auto-selects                              | Device serial                                    |
| output          | no       | `.taphound/journeys/taphound-journey-brief.md`   | Brief output path (relative to project)          |

**Hard rule**: NEVER search for or assume files named `plan.md`,
`requirement.md`, or any convention. Read ONLY files the caller explicitly
passes via `contextPaths`. If no `contextPaths` are supplied, work from
`caseGoal` alone plus source code and Project Context.

## Output

For a Brief run, the Skill writes a `taphound-journey-brief.md` at the
`output` path and returns a structured JSON summary:

```json
{
  "status": "authored",
  "caseId": "CASE-002",
  "path": ".taphound/journeys/taphound-journey-brief.md",
  "sha256": "<exact-byte-hash>",
  "edgesVerified": 2,
  "edgesNeedsObservation": 1
}
```

For a `contextOnly` run, the Skill ensures the Context and returns:

```json
{
  "status": "valid",
  "contextPath": ".taphound/context/project-context.json",
  "modules": [
    { "id": ":app", "status": "complete" },
    { "id": ":feature:search", "status": "complete" }
  ]
}
```

On failure either mode returns:

```json
{
  "status": "failed",
  "failure": { "code": "...", "message": "..." }
}
```

## Phase 0: Preflight and Context Ensure

Prerequisites: Node.js 22+ (avoid 23), Android SDK with ADB and
`uiautomator`, and TapHound built and linked. A device is required for
Brief authoring (Phase 2) but NOT for Context-only runs or any Context
ensure work — doctor may report `DEVICE_UNAVAILABLE`, which is acceptable
whenever the run stays on the Context path.

1. Verify `taphound` is available.
2. Run `taphound doctor --project <project> --json`.
   - Brief run: confirm `"status": "passed"` and capture `deviceSerial`.
   - `contextOnly` run: environment must be usable without a device;
     `DEVICE_UNAVAILABLE` is acceptable.
3. **Context ensure** — this Skill owns the full Context lifecycle. Check
   the Project Context:
   ```bash
   taphound context status \
     --project <project> \
     --context <context> --json
   ```
   - `"valid"`: confirm module completeness with
     `taphound context list --json`. If all selected modules are
     `complete`, the Context is current — proceed to Phase 1 (or return
     the Context summary if `contextOnly`). If any module is incomplete,
     complete that shard first (L1 steps 2–4 for that module only).
   - `"stale"`: run the incremental update flow **L2** below.
   - `"invalid"`: run full regeneration **L3** below.
   - File missing: run initial generation **L1** below.

## Context Lifecycle

These branches run only when Phase 0 detects Context work. After any
branch, re-run `taphound context status --json` and `taphound context
list --json`; proceed only when the Context is `valid` with complete
modules (or intentionally `partial`/`unsupported` — report coverage gaps
to the user).

### L1: Initial Generation (file missing, or explicit `force`)

> Read `prompts/context-analyze-project.md` before starting — it contains
> detailed module-by-module semantic analysis guidance. Read both Context
> schemas (`schemas/project-context.json` and
> `schemas/project-context-module.json`) and both Context templates before
> editing shards.

1. Generate the Context skeleton. Core discovers Gradle modules, inspects
   `applicationId` and launch Activity, computes evidence and inventory
   hashes, and writes one `notAnalyzed` shard per module with an empty
   `summary`:
   ```bash
   taphound context generate \
     --project <project> \
     --json
   ```
   Use `--force` to overwrite an existing Context. Review the generated
   module list and verify `packageName` and `launchActivity` match the
   project; verify `packageName` comes from `applicationId` in
   `build.gradle(.kts)`, NOT from the `package` attribute in
   `AndroidManifest.xml` (deprecated in AGP 7+). Core resolves this
   automatically; verify the result matches the installed app.
2. Fill in semantic summaries. For each shard under
   `.taphound/context/modules/<module>.json`, read the module's source per
   `prompts/context-analyze-project.md` and populate the `summary` object:
   - `features`: domain terms this module contributes
   - `activities`: Activity names, entry points, and screen names
   - `elements`: interactive UI elements per screen with supported actions
   - `transitions`: cross-Activity navigation paths
   - `logcat`: `Log.i`/`Log.d` tag+pattern candidates for expectations
   Set the shard `status` to `complete`, `partial`, or `unsupported`.
   Never leave a shard as `notAnalyzed` after this step.
3. Update the root index (`.taphound/context/project-context.json`):
   - Copy `features`, `activities`, and `status` from each shard into the
     corresponding module entry.
   - Update `interactionPolicy.allowedActions` to match actions the UI
     actually supports (derived from source evidence). Leave
     `confirmationRequiredActions` empty unless ALL instances of an
     action are genuinely dangerous.
4. Rehash to update all shard and index hashes:
   ```bash
   taphound context rehash \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
5. Validate:
   ```bash
   taphound context validate \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
   If validation fails, fix the named index or shard and retry. Common
   failures: package name mismatch, stale hash (run `context rehash`),
   path containing `..` or starting with `/`, file listed in manifest but
   not found on disk.
6. Confirm module completeness via `taphound context list --json`.

### L2: Incremental Update (`stale`, content-only changes)

Run when the Context is `"stale"` but the module catalog has not changed
structurally — the typical update after routine source edits such as a
requirement change.

1. Confirm module completeness with `taphound context list --json`.

   **Decision matrix:**

   | `context status` | Module catalog          | Action                                                          |
   |------------------|-------------------------|-----------------------------------------------------------------|
   | `valid`          | All modules complete    | Context is current. Done.                                       |
   | `valid`          | Any module incomplete   | Complete that module shard (L1 steps 2–4 for that module only)  |
   | `stale`          | Existing module changed | Run `context refresh --json`, act on each block's `resolution`  |
   | `stale`          | Module catalog changed  | L3 (full regeneration)                                          |
   | `invalid`        | —                       | L3 (full regeneration)                                          |

2. Hash-only refresh before any re-analysis:
   ```bash
   taphound context refresh \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
   Read `schemas/context-refresh-result.json` for the full result shape.
   - `"refreshed"` / `"unchanged"`: nothing semantic changed.
     `semanticSha256` values are backfilled, formatting- or comment-only
     edits are rehashed, drifted shard hashes in the index are repaired,
     and the Context is current. Validate and done.
   - `"blocked"`: the response lists modules and files that changed
     semantically, whose inventory changed, or whose evidence is missing.
     Each block carries a `resolution` field — act on it, do not blanket
     re-analyze:

     | block `code`              | `resolution`        | Action                                                                                                              |
     |---------------------------|---------------------|---------------------------------------------------------------------------------------------------------------------|
     | `EVIDENCE_UNRESOLVED`     | `pruneDeleted`      | A tracked file was deleted. Re-run with `--prune-deleted` (drops the entry). Combine with `--accept-source-changes` if inventory also drifted. |
     | `EVIDENCE_SEMANTIC_CHANGED` | `acceptSourceChanges` | A tracked file's semantics changed. Re-run with `--accept-source-changes` to rehash. Re-analyze (step 3) only if the module summary is now wrong. |
     | `MODULE_INVENTORY_CHANGED` | `acceptSourceChanges` | The on-disk file set grew or shrank. Re-run with `--accept-source-changes` to accept the new inventory hash. Re-analyze (step 3) only when new UI files were added that the summary must cover. |
     | `EVIDENCE_UNRESOLVED`     | `reanalyze`         | An evidence file is unreadable/escaped/too large (not a clean deletion). Fix the file or regenerate that module's shard (L1 steps 2–4 for that module only). |

   The typical one-shot reconcile for routine edits + deletions:
   ```bash
   taphound context refresh \
     --project <project> \
     --context .taphound/context/project-context.json \
     --prune-deleted --accept-source-changes --json
   ```

   `--module <id...>` narrows scope. `--accept-source-changes` rehashes
   semantic and inventory drift; use it only after confirming the recorded
   module summary (screens, elements, transitions, Logcat) is still
   accurate, because `refresh` never updates semantics. `--prune-deleted`
   only drops entries for files that are truly gone (`notFound`);
   unreadable or escaped files stay blocked as `reanalyze`.

3. Selective re-analysis (when needed): when a block's `resolution` is
   `reanalyze`, or when `acceptSourceChanges` would hide newly added UI
   screens the Goal may reach, regenerate the affected module shards
   instead of reanalyzing unrelated features:
   1. Identify which files changed (the `context status` output lists them).
   2. Recompute SHA-256 for each changed file (Core does this via
      `context rehash`).
   3. If any changed file is an Activity source, re-read it to check for:
      new Logcat tags (expect candidates), new click handlers or input
      fields (interactionPolicy), new `startActivity` calls (navigation).
   4. If any changed file is a layout XML, re-read it to check for: new
      `android:id` elements (locator candidates), removed elements, changed
      `android:text` or `android:contentDescription`.
   5. Update shard semantics, evidence, and inventory. Write the shard,
      recompute its file hash, and update the root index reference.
   6. Update the global `interactionPolicy` only when needed, then
      rehash and validate (L1 steps 4–5).

### L3: Full Regeneration (`invalid`, or structural changes)

Run full regeneration when:
- A new Gradle module was added or removed (check `settings.gradle`).
- The `packageName` or `launchActivity` changed.
- The Context is `"invalid"` (structural corruption).
- The user explicitly requests a full refresh (`force`).

1. Re-analyze the source (read `prompts/context-analyze-project.md`).
2. Generate with `--force` to overwrite the existing Context:
   ```bash
   taphound context generate \
     --project <project> \
     --force \
     --json
   ```
   Core re-discovers all modules, resolves identity, and writes fresh
   `notAnalyzed` shards.
3. Follow L1 steps 2–6 (fill semantic summaries, update root index,
   rehash, validate, list).

## Phase 1: Case Analysis

> This section is the authoritative Brief procedure. The subagent prompt
> (`prompts/brief-author-role.md`) is a lean bootstrap that directs the
> subagent here; it does not duplicate this procedure. Skip this phase and
> the next two when running with `contextOnly`.

1. If `contextPaths` is provided, read ONLY those explicit files. Extract
   context relevant to `caseGoal`.
2. Read the Project Context root index. Select modules relevant to
   `caseGoal` using their `features`, `activities`, and `transitions`.
3. Read the selected module shards' `summary` objects.
4. Perform targeted source reading for Activities and layouts mentioned in
   the Case:
   - Kotlin/Java: map `setContentView` to Activity→layout, find click
     handlers, `Log.i/d` tags, `startActivity` calls.
   - Layout XML: extract `@+id/<name>` (bare = resourceId), `android:text`,
     `contentDescription`.
5. Build a draft State Transition Map:
   - Edges with clear source evidence → `confidence: source`
   - Inferred edges → `confidence: needs-observation`
6. Extract logcat tag candidates, locator candidates, and idempotency
   notes from source.

## Phase 2: Device Observation (read-only)

If `observeSnapshot` is provided by the orchestrator, use it directly. Do
NOT call `taphound observe` yourself (the orchestrator pre-captured it to
enable parallel brief authoring without device contention).

If `observeSnapshot` is NOT provided and a device is available, you may
run:
```bash
taphound observe --project <project> --device <serial> \
  --logcat-lines 200 --json
```

Verify:
1. `report.foreground.activity` matches the Project Context's
   `launchActivity`.
2. Search `report.layout[]` for the first `source` edge's locator element:
   - Match by `resourceId` → `text` → `contentDescription` priority.
   - Confirm element `enabled: true` and supports the target action
     (e.g., `clickable: true`).
3. Extract logcat tag patterns from `report.logcat[]` for Capability
   Notes.
4. Edges verifiable in the snapshot keep `source` confidence. Edges not
   verifiable remain `needs-observation`.

If no device is available and no snapshot is provided, skip this phase.
All edges retain their Phase 1 confidence.

## Phase 3: Author Brief

1. Use `templates/taphound-journey-brief.template.md` as the skeleton.
2. Fill frontmatter: `schemaVersion: 2`, `kind: taphound.journeyBrief`,
   `caseId` (if provided).
3. Fill all 9 required sections:
   - `# Goal`: from `caseGoal`.
   - `## Preconditions`: from `contextPaths` docs or default
     "independent cold launch".
   - `## Expected Journey`: numbered steps from the State Transition Map
     edge sequence.
   - `## State Transition Map`: Mermaid diagram + edge table with
     confidence and locator hints.
   - `## Capability Notes`: runtime variable capture, multi-field
     locators, logcat semantics.
   - `## Assertions`: from `contextPaths` docs and source analysis.
   - `## Implementation Hints`: resourceIds, module paths.
   - `## Constraints`: no coordinates, Final Replay must pass,
     idempotency notes.
   - `## Evidence References`: source file paths.
4. Write to the `output` path.
5. Compute SHA-256 via shell: `shasum -a 256 <file>`.
6. Return the structured JSON summary.

## Key Rules

- Use ONLY read-only commands: `observe`, `context generate`, `context
  refresh`, `context rehash`, `context validate`, `context status`,
  `context list`, `doctor`, `project describe`. NEVER use `generation`,
  `verify`, `record`, `align`.
- Do NOT modify device state (no clicks, no input, no swipes).
- The agent NEVER computes SHA-256 hashes manually. Core does all Context
  hashing via `context generate`, `context rehash`, and `context refresh`.
- The agent NEVER discovers modules manually. Core parses
  `settings.gradle` and falls back to filesystem scanning.
- The agent NEVER resolves `applicationId` or launch Activity manually.
  Core inspects build files and manifests.
- Do NOT modify Core-owned Context fields: `packageName`,
  `launchActivity`, `manifest.files`, `modules[].shardPath`,
  `modules[].sha256`, `modules[].moduleId`, `modules[].projectDir`, or
  `modules[].kind`. Do NOT add or remove module entries. Do NOT modify
  any `sha256` or `semanticSha256` field — run `context rehash` to
  recompute after edits.
- Paths in `manifest.files` are relative to the Android project root, use
  forward slashes, and must not start with `/` or contain `..`.
- For multi-module projects, include source analysis from all modules that
  contribute to the UI — not just the `app` module. **Completeness is
  mandatory**: enumerate ALL `<activity>` entries from ALL module
  manifests. For layouts using `<include>`, `<merge>`, or `<layout>`,
  resolve transitively.
- `confirmationRequiredActions` is per-action-TYPE. Listing `click` makes
  EVERY click require human approval during generation. Leave empty unless
  ALL instances of an action are dangerous.
- `allowedActions` must be derived from source evidence, not blanket
  inclusion. If no source evidence supports an action, do not list it.
- Do not include build artifacts, generated code, or non-UI files in your
  analysis — Core already excluded them from the evidence manifest.
- NEVER search for or assume files named `plan.md`, `requirement.md`, or
  any convention. Read ONLY files passed via `contextPaths`.
- The Brief is untrusted output — phrase all claims as hints, not
  authoritative assertions.
- Output must pass validation by `consume-journey-brief.md` (9 sections,
  correct frontmatter).
- SHA-256 of the Brief is ALWAYS computed via shell, never guessed.
- One Brief per Case (mirrors the Journey Skill's one-Goal-one-session).
- The agent does NOT modify TapHound Core source code.

## Gotchas

- `packageName` comes from `applicationId` in `build.gradle(.kts)`, NOT
  from the `package` attribute in `AndroidManifest.xml` (deprecated in
  AGP 7+). Core's `context generate` resolves this automatically; verify
  the result matches the installed app.
- The same `@+id/submit` can appear in multiple layout XML files — this is
  normal, not a conflict. Only one layout is active at runtime; always
  match against the `observe` snapshot (Phase 2), not static XML.
- `--accept-source-changes` does NOT re-analyze newly added Activities or
  layouts into the module summary. If the Goal may reach a new screen,
  re-scan that module's source and update its `summary`, then run
  `context rehash` (L2 step 3).
- Context ensure work does NOT require a connected device. `doctor` may
  report `DEVICE_UNAVAILABLE` — that is acceptable for every `context`
  command; a device is only needed for Brief Phase 2.
- `partial`, `unsupported`, and `notAnalyzed` modules are coverage gaps,
  not successful generation. Report them to the user.
