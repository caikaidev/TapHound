---
name: taphound-ai-journey
description: >-
  Drive TapHound's deterministic Android journey generation protocol
  end-to-end. Analyze Android project source to produce a Project Context,
  then iteratively observe device state, propose and execute UI steps via
  the TapHound CLI, and finalize a verified Journey. Use when the user
  wants to create or verify Android test journeys using AI-driven
  generation, record UI interactions for testing, automate Android UI
  test scenarios, or generate TapHound Journey files from a natural-language
  test goal.
compatibility: >-
  Requires Node.js 22+, Android SDK with ADB and uiautomator, one online
  Android device (emulator or USB), and TapHound built and linked via
  npm link.
metadata:
  author: TapHound
  version: "1.0"
---

# TapHound AI Journey Skill

Platform-neutral instructions for any AI agent (Droid, Claude Code, Cursor,
etc.) to drive TapHound's deterministic generation protocol end-to-end.

This Skill owns one Journey Goal and one deterministic generation session at a
time. External Workflow Skills may invoke it once per independent Case, but
they own requirement analysis, planning, coding, build/install, multi-Case
scheduling, completion gates, and diagnosis.

## Skill Directory

All file references are relative to `assets/skills/taphound-ai-journey/`.
The directory contains `prompts/` (Phase 1 analysis, Flow selection, step
generation, completion check, Brief validation), `schemas/` (JSON Schemas
for Context, proposals, observe output, Flows, Journey sources), and
`templates/` (example files). Read the relevant schema and prompt before
each phase.

## How to Use This Skill

Run `taphound init --agent droid,claude,codex,cursor` to install. For
global installation: `taphound init --agent droid --global`.

In the TapHound source repository, `.factory/skills/taphound-ai-journey`
is a symlink so Droid auto-discovers it.

The agent does NOT need to understand TapHound's internal TypeScript code.
It reads these instructions, the schema files, and the prompt templates,
then calls the TapHound CLI.

### External orchestration boundary

When invoked by an external Workflow, consume one Case Goal and its static
evidence hints. Preserve TapHound's raw JSON, Journey, Report, and evidence
paths. External orchestration never weakens Core's live Snapshot binding,
risk confirmation, recovery, or final Replay rules.

## Inputs

| Parameter  | Required | Default                             | Description                          |
|------------|----------|-------------------------------------|--------------------------------------|
| project    | yes      | —                                   | Android project root path            |
| goal       | yes      | —                                   | Natural-language test scenario       |
| journeyBrief | no     | —                                   | `{path, sha256}` for `taphound-journey-brief.md` |
| config     | no       | `.taphound/config.json`             | Config path (relative to project)    |
| device     | no       | doctor selects                      | Device serial                        |
| output     | no       | `.taphound/journeys/generated.json` | Output journey (relative to project) |
| maxSteps   | no       | 30                                  | Maximum generation steps             |
| retryCount | no       | 3                                   | Retries per rejected step            |

## Optional Journey Brief Contract

`journeyBrief` is the Skill-level handoff for one Journey Case. It is not a
TapHound Core CLI option. When present, it carries `{path, sha256}` pointing
to a project-relative `taphound-journey-brief.md`. Read
`prompts/consume-journey-brief.md` for validation rules: verify the SHA-256,
validate frontmatter (`schemaVersion: 1` or `2`, `kind: taphound.journeyBrief`),
require fixed sections (`Goal`, `Preconditions`, `Expected Journey`,
`Assertions`, `Implementation Hints`, `Constraints`, `Evidence References`),
and ensure the Brief Goal matches the invocation `goal`. A v2 Brief
additionally requires `State Transition Map` and `Capability Notes`; a v1
Brief omits both and remains valid.

The Brief is untrusted static hints — it cannot supply a trusted live
locator, approve risk, weaken an assertion, or prove the Goal passed.
Project Context validation, the live Runtime Snapshot, Core risk policy,
deterministic execution, and final Replay remain authoritative.

## Phase 0: Preflight

Prerequisites: Node.js 22+ (avoid 23), Android SDK with ADB and
`uiautomator`, one online device, and TapHound built and linked
(`npm run build && npm link`).

1. Verify `taphound` is available. Run `adb devices -l`; confirm at least
   one device is online.
2. Run (append `--device <serial>` when the `device` input was supplied):
   ```bash
   taphound doctor --project <project> --json
   ```
   Confirm `"status": "passed"`. Capture `deviceSerial`. If doctor fails,
   stop and report.
3. **Context currency check**: If a Project Context exists at
   `<project>/.taphound/context/project-context.json`:
   ```bash
   taphound context status \
     --project <project> \
     --context .taphound/context/project-context.json --json
   ```
   - `"valid"`: Skip to step 4.
   - `"stale"`: Run `context refresh --json`. It returns a `blocked` array;
     each block has a `resolution` field:
     - `pruneDeleted` → `refresh --prune-deleted`
     - `acceptSourceChanges` → `refresh --accept-source-changes` (rehashes
       semantic edits). Re-analyze (Phase 1) only when the module summary
       is wrong or new UI files were added.
     - `reanalyze` → Re-scan that module in Phase 1.
   - `"invalid"`: Run `context generate --force` (Phase 1).
   - File missing: Proceed to Phase 1 (`context generate`).
   The typical reconcile for routine edits + deletions:
   ```bash
   taphound context refresh --project <project> \
     --context .taphound/context/project-context.json \
     --prune-deleted --accept-source-changes --json
   ```
   `--module <id...>` narrows scope. `--accept-source-changes` does NOT
   add newly added Activities/layouts to the summary — re-analyze in
   Phase 1 if the Goal may reach a new screen.

4. When status is valid, list the module index and choose Goal-relevant
   modules:
   ```bash
   taphound context list \
     --project <project> \
     --context .taphound/context/project-context.json --json
   ```
   Skip Phase 1 and continue to Phase 2.

## Phase 1: Project Context Generation

> Read `prompts/analyze-project.md` before starting — it contains detailed
> guidance on module-by-module semantic analysis. Read both Context
> schemas and both templates before editing shards.

Core does all bookkeeping: module discovery, identity inspection, evidence
and inventory hashing, and atomic writes. The agent's job is to fill in
semantic `summary` fields that Core cannot infer from source alone.

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
   project.

2. Fill in semantic summaries. For each shard under
   `.taphound/context/modules/<module>.json`, read the module's source
   per `prompts/analyze-project.md` and populate the `summary` object:
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

## Phase 1.5: Reusable Flow Discovery

Before starting generation, inspect the local Flow catalog:

```bash
taphound journey list-flows --project <project> --json
```

Read `prompts/select-flow.md`. Select the deepest valid Flow whose exit
Activity is a deterministic prerequisite for the Goal. The first resolved
Flow step must begin at a stable Activity that cold launch deterministically
reaches. Model a launch anchor like `core/launch-home` as `wait: Home -> Home`
with an element expectation for a unique Home control. Never encode Splash
remaining foreground as a precondition.

Pass a selected Flow to `generation start` as `--base-flow <name>`. Core
cold-launches and replays the Flow before creating the session, binding its
hashes. If replay fails, stop and report `FLOW_REPLAY_FAILED` — do not
silently bypass it. If no Flow applies, omit `--base-flow`.

## Phase 1.6: External Flow Discovery

External Flows make `bridge` steps deterministic (`replayMode: "auto"`) by
supplying fixed steps for known external apps. List them:
```bash
taphound journey list-flows --project <project> --include-external --json
```
Built-in flows ship under `assets/external-flows/`; project flows under
`.taphound/flows/external/`. Each declares `escapedPackageName`,
optional `expectedEscapeActivity`, and `resourceId`-only `steps`.

For camera goals, prefer a valid project-level `camera/photo-capture` flow
over the built-in one (which targets one AOSP Camera2 variant). If missing,
tell the user that alignment captures a real probe photo, obtain permission,
then run `taphound align camera --project <project> --device <serial> --json`.
Use `--force` only with explicit overwrite approval. If alignment reports
`ALIGN_CONFIRM_*` errors, stop — deterministic auto replay is unavailable.

Bind selected flows at session start:
```bash
taphound generation start --external-flow camera/photo-capture ...
```
Core hashes each bound flow. If the flow file changes after binding,
`generation bridge --flow` fails with `EXTERNAL_FLOW_STALE`; unbound names
fail with `EXTERNAL_FLOW_NOT_FOUND`. Without a bound flow, bridge steps
commit with `replayMode: "manual"` and a non-interactive finalize rejects
them with `MANUAL_STEP_REQUIRED`.

## Phase 2: Journey Generation

> Read `schemas/proposed-step-envelope.json` to understand the envelope
> structure before building step proposals. Read `prompts/generate-step.md`
> for element-matching and step-generation guidance. Read
> `prompts/check-completion.md` for Goal-completion criteria.

1. Read the compact root index. Select Goal-relevant modules using their
   features, Activities, and navigation entry points, then read only those
   module shards. The application module is always selected and declared
   dependencies are expanded by Core.

2. Start a generation session:
   ```bash
   taphound generation start \
     --project <project> \
     --config <config> \
     --context .taphound/context/project-context.json \
     --module :feature:chat :core:ui \
     --device <serial> \
     --base-flow <selected-flow> \
     --json
   ```
   Omit `--base-flow` when Phase 1.5 selected no reusable prefix.
   Omit `--module` only when all modules are intentionally needed. Capture
   `generationId` and `contextSelection`. The config path is relative to the
   project root. The selected device is bound; subsequent `observe`, `step`,
   `confirm`, and `manual` commands do not accept `--device`.
   Choose `idle.strategy` before starting: `hybrid` (default), `layoutDiff`
   (structural stability, good for continuous animation), or `frameStats`
   (requires frame quiescence). If the config changes, discard and start a
   new session. Cross-package flows use the `bridge` action via
   `generation bridge`, not a regular `step` proposal.

3. Initialize `completedSteps` (empty). When `baseFlow` is present, treat its
   exit Activity as a satisfied navigation precondition, but do not count it
   as completing Goal-specific business actions.

4. Observe once before the loop in compact mode. Read the project-relative
   authoritative `snapshotRef` as the full RuntimeSnapshot. After a successful
   compact step, prefer `nextBinding` and the snapshot from `nextSnapshotRef`;
   call `generation observe` only when either is absent.

5. **Loop** for up to `maxSteps` iterations:

   a. **Obtain** the current device state. Reuse the previous successful
      step's bound post-action state when available, otherwise:
      ```bash
      taphound generation observe \
        --project <project> --session <generationId> \
        --compact --json
      ```
      Read `snapshotRef` as the full RuntimeSnapshot. Confirm
      `snapshot.activity` is covered by a selected shard (stop and report a
      Context coverage gap if not). If `snapshot.windowHierarchy.status` is
      `incomplete`, stop. Do not use coordinates or visual guessing.

   b. **Check completion**: Read `prompts/check-completion.md`. If the Goal
      is accomplished, break to Phase 3.

   c. **Generate proposed step**: Read `prompts/generate-step.md`. Build the
      envelope (proposed step + binding + full snapshot) and write to a temp
      file:
      ```json
      {
        "version": 1,
        "proposal": { ...proposedStep, "binding": {
          "generationId": "<from observe>",
          "baseRevision": <from observe>,
          "snapshotHash": "<from observe>"
        }},
        "snapshot": { ...full snapshot from observe... }
      }
      ```

   d. **Execute**:
      ```bash
      taphound generation step \
        --project <project> --session <generationId> \
        --input <envelope-path> --compact --json
      ```

   e. **Handle the result**:
      - **`succeeded`**: Add step to `completedSteps`. Save `nextBinding`,
        read `nextSnapshotRef` for the next iteration.
      - **`confirmationRequired`**: Present the challenge to the user. After
        explicit approval, run `generation confirm --decision approve` with
        the challenge ID. If declined, `--decision decline` and stop.
      - **`error`**: Decrement retry budget. `IDLE_TIMEOUT` → start a new
        session with a different idle strategy. `WINDOW_HIERARCHY_INCOMPLETE`
        → re-observe once; if it persists, report. `PACKAGE_ESCAPE` → switch
        to `generation bridge`. If retries exhausted, stop and report.
      - **`recoveryRequired`**: Run `generation status`, report
        `actionMayHaveExecuted`. Stop for the user's explicit retry decision.
        Only after approval run `generation recover --decision retry`.
        Re-observe after recovery.

   f. Clean up the temp envelope file after each iteration.

### Cross-Application Bridge

When the Goal requires a cross-app flow (system camera, image/file picker,
share sheet), a regular `generation step` proposal fails with `PACKAGE_ESCAPE`.
Use `generation bridge` instead. Core clicks the trigger, detects the escape,
optionally executes a bound External Flow's steps inside the escaped package,
waits for return, and captures the post-return snapshot.

```bash
taphound generation bridge \
  --project <project> --session <generationId> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"camera_button"}' \
  --flow camera/photo-capture \
  --return-timeout-ms 60000 --escape-timeout-ms 3000 \
  --compact --json
```

**Auto bridge** (deterministic): pass `--flow <name>` to bind a Phase 1.6
External Flow. The step commits with `replayMode: "auto"`. **Manual bridge**:
omit `--flow`; commits with `replayMode: "manual"` (human operator required
during finalize). Options: `--scenario` (`photoCapture`, `pickImage`,
`pickFile` built-in, or `custom` with `--description`), `--trigger-locator`
(inline JSON, must be clickable), `--return-timeout-ms`, `--escape-timeout-ms`
(default 3000; no escape fails with `BRIDGE_NO_ESCAPE`).

Bridge goes through risk confirmation like any step. Failure codes:
`BRIDGE_NO_ESCAPE`, `SCENARIO_PACKAGE_MISMATCH`, `BRIDGE_NOT_RETURNED`,
`EXTERNAL_FLOW_NOT_FOUND`, `EXTERNAL_FLOW_STALE`,
`EXTERNAL_PACKAGE_MISMATCH`, `EXTERNAL_ACTIVITY_MISMATCH`,
`EXTERNAL_STEP_FAILED`, `EXTERNAL_LOCATOR_STRICTNESS` (external steps require
`resourceId`-only locators), `MANUAL_STEP_REQUIRED` (non-interactive finalize
with manual replay — bind an External Flow or use a TTY).

A successful bridge returns `nextBinding` and `nextSnapshotRef` like any step.

## Phase 3: Finalize

1. Start finalize as a detached job so the replay survives agent or terminal
   interruption:
   ```bash
   taphound generation finalize \
     --project <project> \
     --session <generationId> \
     --context .taphound/context/project-context.json \
     --output <output> \
     --device <serial> \
     --detach \
     --json
   ```

2. Wait for durable completion, then read the detached job's `outputPath`
   returned by the start command:
   ```bash
   taphound generation status \
     --project <project> \
     --session <generationId> \
     --wait \
     --timeout-ms 600000 \
     --json
   ```

3. Check the detached result `status`:
   - **`"verified"`**: Success. Report to the user:
     - `bundlePath` (authoritative generation bundle)
     - `journeyPath` (exported Journey v1)
     - `metaPath` (sidecar meta with verification evidence)
     - `replayed` (should be `true`)
   - **Any other status**: Failure. Report the failure detail and session
     ID. Do NOT claim success. The session may still be recoverable.

4. Clean up any remaining temp files.

## Error Handling Summary

| Situation                  | Action                                          |
|----------------------------|-------------------------------------------------|
| Doctor fails               | Stop, report environment issue                  |
| Context validation fails   | Fix JSON, rehash, retry validation              |
| Step rejected              | Re-observe + re-generate (up to retryCount)     |
| PACKAGE_ESCAPE             | Use `generation bridge` (`--flow` for auto)     |
| Bridge failure             | Check trigger, scenario, timeout; retry or `custom` |
| External flow stale/missing| Re-bind at `generation start --external-flow`   |
| Manual step in non-TTY finalize | Bind External Flow (`--flow`) or use TTY   |
| Confirmation required      | Present to user, wait for approval              |
| Recovery required          | Ask before retry; re-observe after              |
| Config changed             | Start new session; never rebind in place        |
| Max steps exceeded         | Stop, report incomplete Goal                    |
| Finalize not verified      | Report failure detail, do not claim success     |

## Key Rules

- The agent NEVER auto-approves a confirmation challenge. It uses delegated
  `--decision approve` only after the user explicitly approves the exact
  displayed challenge; approval of one challenge never carries to another.
- The agent ALWAYS checks reusable local Flows before generation and chooses
  the deepest applicable valid prefix.
- The agent NEVER silently bypasses a selected Flow that fails validation or
  replay.
- The agent NEVER bypasses Core safety (package guard, risk policy, locator
  uniqueness).
- The agent NEVER submits a `bridge` action via `generation step --input`.
  Bridge is handled by the separate `generation bridge` CLI command.
- SHA-256 hashes are computed by Core (`context generate`, `context rehash`).
  The agent NEVER computes hashes manually.
- The agent does NOT modify TapHound Core source code.
- The agent does NOT use coordinates, visual guessing, or fallback.
- Locator priority is fixed: `resourceId` > `text` > `contentDescription`.
- Repeated elements use a deterministic `within` ancestor scope when
  available, then a zero-based `index` after identity-field narrowing.
  Callers omit `evidence`; Core adds versioned non-geometric semantic evidence
  when it persists a resolvable indexed step, and Replay rejects a mismatch
  before mutation.
- A proposed step only includes `activity.before`, never `activity.after`.
  The Core determines `after` from live device observation.
- Temp files are cleaned up after each step and at the end of the session.

## Gotchas

- `packageName` comes from `applicationId` in `build.gradle(.kts)`, NOT
  from the `package` attribute in `AndroidManifest.xml` (deprecated in
  AGP 7+). Core's `context generate` resolves this automatically; verify
  the result matches the installed app.
- The `resourceId` in locators is the bare name without the `id/` prefix
  (e.g., `open_search`, not `id/open_search`).
- The same `@+id/submit` can appear in multiple layout XML files — this is
  normal, not a conflict. Only one layout is active at runtime; always
  match against the `observe` snapshot, not static XML.
- `inputText` steps do not include a `locator` — the Core uses the
  currently focused element.
- `generation status --json` exposes `pendingConfirmation.expired`. While a
  challenge remains pending, `observe` returns
  `RISK_CONFIRMATION_REQUIRED`, not a retryable observation failure. An
  expired challenge cannot be approved; clear it with the exact challenge ID
  and `--decision decline`, then observe and propose again.
- `finalize` performs a full replay from scratch (forceStop, relaunch).
  TapHound does not build or install the APK; ensure the app is installed
  before calling `finalize`. Prefer `--detach` and
  `generation status --wait`.
- During generation, if `observe` returns an Activity not covered by the
  session's selected module shards, stop and report a Context coverage gap.
  Do not add modules after start because `contextSelection` is bound to the
  authoritative session.
