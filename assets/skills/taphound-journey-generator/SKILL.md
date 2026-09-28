---
name: taphound-journey-generator
description: >-
  Drive TapHound's deterministic Android journey generation protocol
  end-to-end. Iteratively observe device state, propose and execute UI
  steps via the TapHound CLI, and finalize a verified Journey. Requires a
  valid Project Context (produced by the taphound-journey-brief-author skill).
  Use when the user wants to create or verify Android test journeys using
  AI-driven generation, record UI interactions for testing, automate
  Android UI test scenarios, or generate TapHound Journey files from a
  natural-language test goal.
compatibility: >-
  Requires Node.js 22+, Android SDK with ADB and uiautomator, one online
  Android device (emulator or USB), and TapHound built and linked via
  npm link.
metadata:
  author: TapHound
  version: "1.0"
---

# TapHound Journey Generator Skill

Platform-neutral instructions for any AI agent (Droid, Claude Code, Cursor,
etc.) to drive TapHound's deterministic generation protocol end-to-end.

This Skill owns one Journey Goal and one deterministic generation session at a
time. External Workflow Skills may invoke it once per independent Case, but
they own requirement analysis, planning, coding, build/install, multi-Case
scheduling, completion gates, and diagnosis.

Those stages may use `verify --diff`, `failure classify`, `baseline`, and
`contract`; this Skill's contract stays one Case Goal, one deterministic
generation session, and final Replay in `generation finalize`.

Generation commands canonicalize a relative `--project` before binding it.
Replay waits up to the bound idle timeout when an action locator is absent,
using fresh snapshots; ambiguity and locator-evidence drift still fail
immediately. If final Replay deterministically fails, use `generation reopen
--reason <text>` before `generation step --replace <index>` so the failed
attempt remains in `verificationHistory`. Interrupted verification continues
to use `generation recover --decision retry`, whose `nextAction` requires
rerunning finalize.

This Skill requires a valid Project Context as a prerequisite. The
`taphound-journey-brief-author` Skill is the recommended producer — it analyzes
Android source and maintains the Context Bundle. When this Skill encounters
a stale or invalid Context, it stops and requires `taphound-journey-brief-author`
to run first; it never generates or repairs Context itself.

## Skill Directory

All file references are relative to this Skill's directory. It contains
`prompts/` (Flow selection, step generation, completion check, Brief
validation), `references/` (mid-session corrections, cross-app bridge),
`schemas/` (JSON Schemas for proposals, observe output, Flows, Journey
sources), `templates/` (example files), and `scripts/envelope.mjs` (offline
envelope validation plus binding auto-fill).
Read the relevant schema and prompt before each phase.

## How to Use This Skill

The agent does NOT need TapHound's source code. It reads these instructions,
the schema files, and the prompt templates, then calls the TapHound CLI.

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

`journeyBrief` is the Skill-level handoff for one Journey Case. When present,
it carries `{path, sha256}` pointing to a project-relative
`taphound-journey-brief.md`. Bind the same path into Core with
`generation start --brief <path>`: Core reads the file itself, computes the
SHA-256 (never trust an agent-supplied hash), and persists `sourceBrief` in
the session and the exported meta sidecar, so `journey check` reports
`brief-drift` or `brief-missing` when the Brief later changes. Read
`prompts/consume-journey-brief.md` for validation rules: verify the SHA-256,
validate frontmatter (`schemaVersion: 2`, `kind: taphound.journeyBrief`),
require fixed sections (`Goal`, `Preconditions`, `Expected Journey`,
`Assertions`, `Implementation Hints`, `Constraints`, `Evidence References`),
and ensure the Brief Goal matches the invocation `goal`. The Brief
additionally requires `State Transition Map` and `Capability Notes`.

The `taphound-journey-brief-author` Skill authors the Brief and returns
`{path, sha256}`.

The Brief is untrusted static hints — it cannot supply a trusted live
locator, approve risk, weaken an assertion, or prove the Goal passed.
Project Context validation, the live Runtime Snapshot, Core risk policy,
deterministic execution, and final Replay remain authoritative.

## Phase 0: Preflight

Prerequisites: Node.js 22+ (avoid 23), Android SDK with ADB and
`uiautomator`, one online device, TapHound built and linked
(`npm run build && npm link`), and a **valid Project Context** (produced by
the `taphound-journey-brief-author` Skill).

1. Verify `taphound` is available. Run `adb devices -l`; confirm at least
   one device is online.
2. Run (append `--device <serial>` when the `device` input was supplied):
   ```bash
   taphound doctor --project <project> --json
   ```
   Confirm `"status": "passed"`. Capture `deviceSerial`. If doctor fails,
   stop and report.
3. **Context currency check** — this Skill requires a valid Context and
   never generates or repairs it. If a Project Context exists at
   `<project>/.taphound/context/project-context.json`:
   ```bash
   taphound context status \
     --project <project> \
     --context .taphound/context/project-context.json --json
   ```
   - `"valid"`: Proceed to step 4.
   - `"stale"`: **Stop and report.** The Context is stale. Run the
     `taphound-journey-brief-author` Skill to refresh it before generating a
     Journey.
   - `"invalid"`: **Stop and report.** The Context is structurally
     invalid. Run the `taphound-journey-brief-author` Skill to regenerate it.
   - File missing: **Stop and report.** No Project Context exists. Run the
     `taphound-journey-brief-author` Skill to generate one before generating a
     Journey.
4. When status is valid, list the module index and choose Goal-relevant
   modules:
   ```bash
   taphound context list \
     --project <project> \
     --context .taphound/context/project-context.json --json
   ```
   Continue to Phase 1 (Flow Discovery).

## Phase 1: Reusable Flow Discovery

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

## Phase 2: External Flow Discovery

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

## Phase 3: Journey Generation

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
   Omit `--base-flow` when Phase 1 selected no reusable prefix.
   Omit `--module` only when all modules are intentionally needed. Capture
   `generationId` and `contextSelection`. The config path is relative to the
   project root. The selected device is bound; subsequent `observe`, `step`,
   `confirm`, and `manual` commands do not accept `--device`.
   Choose `idle.strategy` before starting: `hybrid` (default), `layoutDiff`
   (structural stability, good for continuous animation), or `frameStats`
   (requires frame quiescence). Any config change after start requires a new
   session, except the idle policy, which can be hot-adjusted mid-session
   with `generation config idle` (see Correcting and Adjusting below).
   Cross-package flows use the `bridge` action via
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
       is accomplished, break to Phase 4.

   c. **Generate proposed step**: Read `prompts/generate-step.md`. Build the
      envelope (proposed step + binding + full snapshot) and write to a temp
      file. Prefer the offline helper instead of hand-copying binding fields:
      ```bash
      node <skill>/scripts/envelope.mjs bind \
        --input <draft-envelope-path> \
        --from <previous-observe-or-step-output-path> \
        --out <envelope-path>
      ```
      The draft envelope needs only `version` and `proposal` (binding may be
      omitted or stale); `bind` fills `proposal.binding` from the preceding
      observe output, step output, or raw binding, adds `snapshotRef` when
      absent, and validates the result offline. The helper contract:
      `node <skill>/scripts/envelope.mjs help`. The resulting shape:
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
       - **`error`**: Decrement retry budget. `IDLE_TIMEOUT` → hot-adjust the
         session idle policy with `generation config idle` (no restart), then
         re-observe. `WINDOW_HIERARCHY_INCOMPLETE`
         → re-observe once; if it persists, report. `PACKAGE_ESCAPE` → switch
         to `generation bridge`. If retries exhausted, stop and report.
      - **`recoveryRequired`**: Run `generation status`, report
        `actionMayHaveExecuted`. Stop for the user's explicit retry decision.
        Only after approval run `generation recover --decision retry`.
        Re-observe after recovery.

   f. Clean up the temp envelope file after each iteration.

### Correcting, Adjusting, and Leaving the App

- A committed step was wrong: rewind with `generation step --replace <index>`
  instead of restarting or building on the mistake.
- `IDLE_TIMEOUT` recurs or the screen needs another stability strategy:
  patch the session's policy with `generation config idle`.
- The Goal crosses into another app (camera, picker, share sheet) and a
  regular step fails with `PACKAGE_ESCAPE`: use `generation bridge`, with
  `--flow` to bind a Phase 2 External Flow for deterministic replay.

Read `references/mid-session.md` before replacing a step or changing the
idle policy, and `references/bridge.md` before any bridge: both change the
session revision and have preconditions that fail with `CONFIG_INVALID`,
`FLOW_INVALID`, or bridge-specific codes.

### Semantic Anchors

Generation proposals always target a `locator`; Core binds it to the
observed element. Knowledge Anchors (`.taphound/knowledge/`) are for
hand-authored Journeys and Contracts that `verify` replays, not for
`generation step`. After editing Knowledge documents, rebuild and validate
the index with `taphound knowledge rehash --project <project> --json` and
`taphound knowledge status --project <project> --json`.

## Phase 4: Finalize

1. Start finalize as a detached job so the replay survives agent or terminal
   interruption:
   ```bash
   taphound generation finalize \
      --project <project> \
      --session <generationId> \
      --output <output> \
      --detach \
      --json
   ```
   Finalize resolves the Context from the session's stored snapshot
   (written at `generation start`, integrity-bound to the session's
   `contextHash`), so unrelated source edits after start cannot scrap the
   session; live Context drift is reported to stderr as a warning.

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
       - `journeyPath` (exported Journey v2)
      - `metaPath` (sidecar meta with verification evidence and the bound
        `contextSelection` module set)
      - `replayed` (should be `true`)
   - **Any other status**: Failure. Report the failure detail and session
     ID. Do NOT claim success. The session may still be recoverable.

4. Confirm the published Journey is fresh against the live project:
   ```bash
   taphound journey check \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
   The newly published Journey must classify as `fresh`. `journey check`
   audits every committed Journey under `.taphound/journeys` by comparing
   its sidecar bindings (project, config, and `contextSelection` module
   hashes, plus the Brief content hash when `sourceBrief` is bound) against
   the live project. `--strict` exits `1` when any Journey
   is stale, invalid, or missing its sidecar — suitable for CI. A bound Brief that changed or disappeared reports
   `brief-drift` or `brief-missing` respectively.

5. Promote the replay-verified Journey into a durable asset when it should
   become a protected baseline:
   ```bash
   taphound journey promote \
     --project <project> \
     --journey <journeyPath> \
     --reason <text> \
     --json
   ```
   Promotion re-hashes the generation bundle's verification report, compares
   the exported Journey against the bundle's verified Journey evidence, and
   rewrites the meta sidecar to `status: "promoted"` with the promotion
   record. It fails closed (exit code 2) on missing evidence, report hash
   drift, a Journey modified after verification, or an already promoted
   sidecar.

6. Clean up any remaining temp files.

## Error Handling Summary

| Situation                  | Action                                          |
|----------------------------|-------------------------------------------------|
| Doctor fails               | Stop, report environment issue                  |
| Context stale/invalid/missing | Stop, run `taphound-journey-brief-author` skill first |
| Context validation fails   | Stop, run `taphound-journey-brief-author` skill first |
| Step rejected              | Re-observe + re-generate (up to retryCount)     |
| Wrong step, IDLE_TIMEOUT, PACKAGE_ESCAPE, bridge or External Flow failure, manual step in non-TTY finalize | See "Correcting, Adjusting, and Leaving the App" and its references |
| Confirmation required      | Present to user, wait for approval              |
| Recovery required          | Ask before retry; re-observe after              |
| Config changed             | Start new session; only idle policy is hot-adjustable |
| Knowledge document stale  | Run `knowledge rehash`; it affects `verify`, not the session |
| Max steps exceeded         | Stop, report incomplete Goal                    |
| Finalize not verified      | Report failure detail, do not claim success     |
| `journey promote` fails closed | Journey or report drifted from the verified bundle; re-finalize on the original session, then promote |
| Journey check reports stale/invalid | Inspect `reasons`; refresh Context or regenerate the Journey |

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
- SHA-256 hashes are computed by Core. The agent NEVER computes hashes
  manually. Context hashes are maintained by the `taphound-journey-brief-author`
  Skill; this Skill consumes a validated Context.
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
  AGP 7+). The `taphound-journey-brief-author` Skill resolves this automatically;
  verify the result matches the installed app.
- The `resourceId` in locators is the bare name without the `id/` prefix
  (e.g., `open_search`, not `id/open_search`).
- The same `@+id/submit` can appear in multiple layout XML files — this is
  normal, not a conflict. Only one layout is active at runtime; always
  match against the `observe` snapshot, not static XML.
- `inputText` steps do not include a `locator` — the Core uses the
  currently focused element.
- `inputText` with non-ASCII text (CJK, emoji, accents) is not typed through
  `adb shell input text`, which cannot deliver those characters. The ADB
  backend automatically routes non-ASCII text through the mobilenext
  devicekit clipboard (set clipboard by broadcast, `KEYCODE_PASTE`, clear
  clipboard). That app must be installed on the device, otherwise the step
  fails with a message naming
  `https://github.com/mobile-next/devicekit-android`. Do not work around a
  missing devicekit by substituting ASCII text when the Case requires the
  original characters.
- `logcat` expectations bind a pattern, not a captured line. Keep `literal`
  patterns to the stable prefix emitted by the source and drop run-varying
  tails (identity hashes like `@1f3a2b`, timestamps, durations, IDs), or
  switch to `match: "regex"` anchored on the stable words. A whole line
  copied from one device run will not reproduce on replay.
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
- `UI_SNAPSHOT_FAILED` exits `3`: it is an environment failure, not
  evidence about the app. Rerun before diagnosing the Journey.
- Repeated `UI_SNAPSHOT_FAILED` ("UIAutomator dump failed") on a slow or
  busy device usually means the dump deadline is too tight, not that the
  device is broken. Raise `ui.snapshotTimeoutMs` in `.taphound/config.json`
  (for example 10000 → 60000) and start a new session; config changes after
  start invalidate the session.
- Source evidence drifts while you work (branch switches, concurrent edits).
  `generation start` fail-closes with `CONTEXT_STALE` naming one file. Run
  `context refresh` (add `--accept-source-changes`/`--prune-deleted` after
  reviewing the named changes), then retry. Never pass
  `--allow-evidence-drift` to "save time".
