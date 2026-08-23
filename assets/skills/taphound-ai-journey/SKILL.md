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

## Skill Directory

All file references in this document are relative to the Skill directory:

```
assets/skills/taphound-ai-journey/
├── SKILL.md                              # This file (entry point)
├── GUIDE.md                              # Detailed step-by-step usage guide
├── prompts/
│   ├── analyze-project.md                # Phase 1: source analysis guidance
│   ├── select-flow.md                    # Phase 1.5: reusable Flow selection
│   ├── generate-step.md                  # Phase 2: next-step generation guidance
│   └── check-completion.md               # Phase 2: Goal completion check
├── schemas/
│   ├── project-context.json              # v2 root index JSON Schema
│   ├── project-context-module.json       # v2 module shard JSON Schema
│   ├── proposed-step-envelope.json       # {version, proposal, snapshot} envelope
│   ├── observe-output.json               # generation observe --json output shape
│   ├── flow.json                         # reusable Flow authoring shape
│   └── journey-source.json               # composed leaf Journey source shape
└── templates/
    ├── project-context.example.json      # Root index example
    ├── project-context-module.example.json # Module shard example
    ├── flow.example.json                 # reusable Flow example
    └── journey-source.example.json       # composed leaf source example
```

When this document says "Read `prompts/analyze-project.md`", the full path is
`assets/skills/taphound-ai-journey/prompts/analyze-project.md` (relative
to the repository root that contains the `assets/` directory).

## How to Use This Skill

This Skill ships with the TapHound npm package at `assets/skills/taphound-ai-journey/`.
Run `taphound init` to copy it into each agent's expected skill directory:

```bash
taphound init --agent droid,claude,codex,cursor
```

For global (user-level) installation:

```bash
taphound init --agent droid --global
```

In the TapHound source repository, `.factory/skills/taphound-ai-journey` is a
symlink to `assets/skills/taphound-ai-journey` so Droid auto-discovers it.

- **Droid**: Auto-discovered from `.factory/skills/` (or run `taphound init --agent droid`).
  Invoke with the Skill tool when the user wants to generate or verify an Android journey.
- **Claude Code**: Run `taphound init --agent claude` to install to `.claude/skills/`,
  then invoke with the Skill tool.
- **Codex**: Run `taphound init --agent codex` to install to `.agents/skills/`.
- **Cursor**: Run `taphound init --agent cursor` to install to `.cursor/skills/`.
- **Other agents**: Run `taphound init --agent other` to install to `.agents/skills/`.

The agent does NOT need to understand TapHound's internal TypeScript code.
It only needs to read these instructions, the schema files, and the prompt
templates, then call the TapHound CLI.

## Prerequisites

- Node.js 22+ (avoid Node 23)
- Android SDK with ADB and `uiautomator` (Android CLI)
- One online Android device (emulator or USB)
- TapHound built and linked: `npm run build && npm link` (registers the
  `taphound` command)

## Inputs

| Parameter  | Required | Default                               | Description                          |
|------------|----------|---------------------------------------|--------------------------------------|
| project    | yes      | —                                     | Android project root path            |
| goal       | yes      | —                                     | Natural-language test scenario       |
| config     | no       | `taphound.config.json`                | TapHound config path (relative to project) |
| device     | no       | doctor selects                        | Device serial                        |
| output     | no       | `.taphound/journeys/generated.json`   | Output journey path (relative to project) |
| maxSteps   | no       | 30                                    | Maximum generation steps             |
| retryCount | no       | 3                                     | Retries per rejected step            |

## Phase 0: Preflight

1. Verify `taphound` command is available. If not, run `npm run build &&
   npm link` in the TapHound repo.
2. Run `adb devices -l`. Confirm at least one device is online.
3. Run (append `--device <serial>` when the `device` input was supplied):
   ```bash
   taphound doctor --project <project> --json
   ```
   Confirm `"status": "passed"`. Capture `deviceSerial` from the result.
   If `device` was supplied, use it; otherwise use the doctor's selection.
   If doctor fails, stop and report the failure.

4. **Context currency check**: If a Project Context already exists at
   `<project>/.taphound/context/project-context.json`, verify it is
   still valid before reusing it:
   ```bash
   taphound context status \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
   - `"valid"`: Index, shard, evidence, and module inventory hashes match.
   - `"stale"`: Tracked files changed. The `--json` output carries a
     `scopes` array (one entry per module: `inventoryChanged`,
     `missingPaths`, `changedPaths`) so you can see exactly which modules
     drifted without a second call. Resolve per the matrix below.
   - `"invalid"`: Needs full regeneration.
   - If the file does not exist, proceed to Phase 1 (full generation).

   When `status` is `stale`, run `context refresh --json` to get the
   scoped, machine-readable diagnostic. `refresh` returns a `blocked`
   array; each block has a `code` **and a `resolution`** field. Act on
   the `resolution`, NOT a blanket "re-analyze":

   | block `code` | `resolution` | What it means | Action |
   |---|---|---|---|
   | `EVIDENCE_UNRESOLVED` | `pruneDeleted` | A tracked evidence file was deleted from disk | `refresh --prune-deleted` (drops the stale entry). Combine with `--accept-source-changes` if inventory also drifted. |
   | `EVIDENCE_SEMANTIC_CHANGED` | `acceptSourceChanges` | A tracked file's semantics changed | `refresh --accept-source-changes` rehashes it. Only re-analyze (Phase 1) if the module summary is now wrong. |
   | `MODULE_INVENTORY_CHANGED` | `acceptSourceChanges` | The on-disk file set grew or shrank | `refresh --accept-source-changes` accepts the new inventory hash. Re-analyze (Phase 1) only when new UI files were added that the summary must cover. |
   | `EVIDENCE_UNRESOLVED` | `reanalyze` | An evidence file is unreadable/escaped/too large (not a clean deletion) | Fix the file or regenerate that module's shard in Phase 1. |

   The typical reconcile for routine edits + deletions is one command:
   ```bash
   taphound context refresh \
     --project <project> \
     --context .taphound/context/project-context.json \
     --prune-deleted --accept-source-changes --json
   ```
   `--prune-deleted` drops entries for files no longer on disk;
   `--accept-source-changes` rehashes semantic edits and accepts inventory
   drift. `--module <id...>` narrows the scope. `refresh` backfills
   `semanticSha256`, rehashes formatting-only changes, and repairs
   drifted shard/index hashes. It never removes a file for a non-deletion
   reason (unreadable/escape/too-large stay blocked as `reanalyze`).
   **Caveat:** `--accept-source-changes` makes the Context pass freshness
   checks by hash, but it does NOT re-analyze newly added Activities or
   layouts into the module summary. If the Goal may reach a newly added
   screen, re-analyze that module in Phase 1 instead; otherwise a
   `Context coverage gap` can surface during generation.

5. When status is valid, list the compact module index and choose the modules
   relevant to the Goal:
   ```bash
   taphound context list \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
   Skip Phase 1 and continue to Phase 2.

## Phase 1: Project Context Generation

> Read `prompts/analyze-project.md` before starting — it contains detailed
> guidance on module-by-module discovery and analysis. Read both Context
> schemas and both templates before writing files.

1. Analyze the Android project source per `prompts/analyze-project.md`:
   - Discover modules via `./gradlew projects` (fallback: parse
     `settings.gradle`).
   - Determine `applicationId` from the app module's build file.
   - Identify the launch Activity from the app module's manifest.
2. Analyze every discovered Gradle module as an independent bounded task and
   write one shard under `.taphound/context/modules/`. Never defer feature
   modules because the complete project is large. Each catalog entry and
   shard must say `complete`, `partial`, `unsupported`, or `notAnalyzed`.
3. Put reusable Activity, screen, element, transition, and Logcat semantics
   in each shard. Compute its inventory hash by sorting all project-relative
   paths in the selected categories, joining them with `\n`, and hashing that
   exact string.
4. Compute SHA-256 for each evidence file:
   ```bash
   node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<project>/<relative-path>')).digest('hex'))"
   ```
   NEVER guess a hash. Always compute it.
   Also include `semanticSha256` when available. It is computed after
   conservatively removing comments and formatting whitespace while preserving
   string contents and all other tokens. Files without this field retain strict
   full-file hash validation.
5. Write each module shard, hash the complete shard file, and put that hash
   and module routing metadata in the root index.
6. Write the root index to
   `<project>/.taphound/context/project-context.json`.
7. Validate:
   ```bash
   taphound context validate \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
8. If validation fails, fix the named index or shard and retry.
   Common failures:
   - Package name mismatch between `taphound.config.json` and Context.
   - Stale or incorrect SHA-256 hash.
   - Path containing `..` or starting with `/`.
   - File listed in manifest but not found on disk.

## Phase 1.5: Reusable Flow Discovery

Before starting generation, inspect the validated local Flow catalog:

```bash
taphound journey list-flows \
  --project <project> \
  --json
```

Read `prompts/select-flow.md`. Select the deepest valid Flow whose exit
Activity is a deterministic prerequisite for the Goal. Do not select by name
alone. Invalid Flows are not reusable; report their diagnostics instead of
silently regenerating the shared prefix.

The first resolved Flow step must begin at a stable Activity that cold launch
deterministically reaches. `run.activity` identifies only the Activity Core
launches; it may be a transient Splash that redirects before observation.
Never encode Splash remaining foreground as a precondition. Model a launch
anchor such as `core/launch-home` as `wait: Home -> Home` with an `element`
expectation for a unique Home control.

Pass a selected Flow to `generation start` as `--base-flow <name>`. Core
cold-launches and exactly replays the resolved Flow before creating the
generation session. It binds the resolution, Journey, and verification hashes,
and records the Flow steps as the immutable candidate prefix.

If no Flow applies, omit `--base-flow`. If replay fails, stop and report
`FLOW_REPLAY_FAILED`, including its Flow name, Verify report path, primary
failure, failed-step summary, and recovery guidance. Do not treat a current
Home screen as proof that the original Flow replayed. Repair or re-record the
Flow. Only bypass it when the user explicitly requests generation without
reuse.

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
   `generationId` and `contextSelection` from the result. The config path is relative to
   the project root. The selected device is bound to this session; subsequent
   `observe`, `step`, `confirm`, and `manual` commands use the session binding
   and do not accept `--device`.
   When no Base Flow is selected, Core force-stops, launches the configured
   Activity, and waits for the App process before it creates the session.
   `run.activity` is only the cold-launch entry; the first observation's
    existing idle/layout checks determine the stable generation start after any
    automatic redirect. Never add launcher navigation as a Journey step.
    Cross-package flows (camera, picker, share sheet) use the `bridge` action
    via `generation bridge`, not a regular `step` proposal.
   The normalized config is also immutable for the session. Choose
   `idle.strategy` before starting:
   - `hybrid` (default) uses fast frame counters and falls back to Core-owned
     UIAutomator layout hashes when rendering continues.
   - `layoutDiff` uses structural layout stability directly and is appropriate
     for apps with known continuous animation or polling.
   - `frameStats` requires frame quiescence and can intentionally time out on
     continuously rendering screens.
   If the config changes for any reason, discard this session and start a new
   one. Do not retry a command against a mismatched session.

3. Initialize a `completedSteps` list (empty at start). When `baseFlow` is
   present, treat its exit Activity as an already satisfied navigation
   precondition, but do not count it as completing Goal-specific business
   actions or assertions.

4. Observe once before the loop in compact mode. Read the project-relative
   authoritative `snapshotRef` as the full RuntimeSnapshot. After a successful
   compact step, prefer `nextBinding` and the snapshot read from
   `nextSnapshotRef`; call `generation observe` only when either is absent.
   Active sessions use a Store-owned
   `.taphound/build/generations/.<generationId>.work/...` reference. Final
   publication atomically moves the same evidence under `<generationId>/...`.

5. **Loop** for up to `maxSteps` iterations:

   a. **Obtain** the current device state. Reuse the previous successful
      step's bound post-action state when available, otherwise run:
      ```bash
      taphound generation observe \
        --project <project> \
        --session <generationId> \
        --compact \
        --json
      ```
      Parse the result. Capture:
      - `generationId`, `baseRevision`, `snapshotHash` (the binding).
      - `snapshotRef`, then read that project-relative JSON file as `snapshot`
        (the full RuntimeSnapshot, including `layout` and window-hierarchy
        diagnostics when available). Never construct the snapshot from the
        compact output.
      - Confirm `snapshot.activity` is covered by one selected shard. If not,
        stop and report a Context coverage gap. Modules cannot be added after
        session start because the selected set is cryptographically bound.
      - If `snapshot.windowHierarchy.status` is `incomplete`, stop before
        proposing a step. Report its diagnostics and recovery guidance. Do
        not use coordinates or infer controls from the screenshot. An
        `APP_WINDOW_NOT_ACCESSIBILITY_READABLE` diagnostic means the app shows
        a window that cannot take focus; the app has to make that window
        focusable in debug builds before the journey can continue.

   b. **Check completion**: Read `prompts/check-completion.md`. Using the
      Goal and `completedSteps`, determine if the Goal is accomplished.
      If `{"complete": true}`, break out of the loop and go to Phase 3.

   c. **Generate proposed step**: Read `prompts/generate-step.md`. Using the
      Goal, selected module summaries, `snapshot.layout`, and
      `snapshot.activity`,
      generate the next proposed step JSON (without `binding`).

   d. **Build the envelope**: Combine the proposed step with the binding and
      snapshot:
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
      Write this to a temporary file (e.g., `/tmp/taphound-step-<timestamp>.json`).

   e. **Execute the step**:
      ```bash
      taphound generation step \
        --project <project> \
        --session <generationId> \
        --input <envelope-path> \
        --compact \
        --json
      ```

   f. **Handle the result**:
      - **`status: "succeeded"`**: Add the step to `completedSteps`. Clean
        up the temp file. Save `nextBinding`, then read `nextSnapshotRef` as
        the next iteration's authoritative full snapshot when both are
        present. Inspect `timing` to attribute Core freshness, action, idle,
        expectation, collection, and next-observation time. Otherwise
        re-observe before proposing another step.
      - **`status: "confirmationRequired"`**: Present the challenge details
        (action summary, challenge ID, and expiry) to the user. Wait for an
        explicit decision on that exact challenge. If approved, run:
        ```bash
        taphound generation confirm \
          --project <project> \
          --session <generationId> \
          --challenge <challengeId> \
          --decision approve \
          --compact \
          --json
        ```
        The `confirmationRequired` response omits `nextBinding` and
        `nextSnapshotRef`; it does not return usable null bindings. A successful
        approval executes the challenged step, and the `confirm` result carries
        the same `nextBinding` and `nextSnapshotRef` as any successful compact
        step. Continue from those values when both are present.
        `--decision approve` is a delegated non-TTY attestation, not an
        auto-approval switch. Use it only after the user explicitly approves
        this challenge. If the user declines, run the same command with
        `--decision decline` to clear the exact challenge, then stop and
        report. Omitting `--decision` keeps the local TTY prompt.
      - **`status: "error"` (any failure code)**: Read the failure code and
        message. Decrement the retry budget for this step.
        This status means Core did not start an ambiguous action attempt, so
        the session normally remains active.
        - For `IDLE_TIMEOUT`, inspect `failure.details.idle`, including
          `strategy`, `backend`, `fallbackUsed`, `frameActivityDetected`,
          `polls`, `durationMs`, and `lastDiff`. Do not edit the bound config
          and continue the same session. If another idle strategy is needed,
          stop and start a new session with the updated config.
        - For `WINDOW_HIERARCHY_INCOMPLETE`, do not substitute coordinates or
          visual guessing. Re-observe once. If it persists, report the
          structured diagnostics and use Layout Inspector for developer
          diagnosis or an opt-in debug WindowInspector backend.
        - For `PACKAGE_ESCAPE`: the proposed action would leave the target
          app. Do not retry the same action via `generation step`. Instead,
          use `generation bridge` (see **Cross-Application Bridge** below)
          which lets Core own the trigger click, detect the escape, wait for
          return, and capture the post-return snapshot in a single committed
          step with `replayMode: "manual"`.
        - If retries remain: re-observe (go back to step a) and re-generate
          the step, this time accounting for the failure feedback (e.g., if
          the locator was not found, try a different locator; if the
          activity was wrong, adjust the prediction).
        - If retries are exhausted: stop and report the failure with the
          session ID, last error, and step index.
      - **`status: "recoveryRequired"`**: Run `generation status` and report
        its immutable attempt outcome plus `actionMayHaveExecuted`. Stop for
        the user's explicit retry decision. Only after approval run
        `generation recover --decision retry`; never silently repeat the
        potentially side-effecting action. Recovery only reactivates the
        session; it does not commit the interrupted action and does not return
        `nextBinding` or `nextSnapshotRef`. Re-observe after recovery. If the
        observed state proves the old action already executed, do not continue
        with a Journey that omits that action and do not replay it
        automatically. Stop and start a clean session until Core provides an
        explicit reconcile transition.

   g. Clean up the temp envelope file after each iteration (success or
      failure).

### Cross-Application Bridge

When the Goal requires a cross-app flow (system camera, image/file picker,
share sheet), a regular `generation step` proposal fails with `PACKAGE_ESCAPE`
because the foreground leaves the target package. Use `generation bridge`
instead. Core clicks the trigger, detects the escape, waits for return, and
commits the step with `replayMode: "manual"`.

```bash
taphound generation bridge \
  --project <project> \
  --session <generationId> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"camera_button"}' \
  --return-timeout-ms 60000 \
  --compact \
  --json
```

- `--scenario`: `photoCapture`, `pickImage`, `pickFile` (built-in, package
  validated), or `custom` (skips validation, requires `--description`).
- `--trigger-locator`: inline JSON Locator for the element that initiates the
  cross-app transition. Must resolve to a clickable element.
- `--return-timeout-ms`: how long Core waits for the foreground to return.

Like `generation manual`, `bridge` goes through risk confirmation. If the
response is `confirmationRequired`, present the challenge to the user and call
`generation confirm --decision approve|decline` with the exact challenge ID.

Bridge failure codes:
- `BRIDGE_NO_ESCAPE`: the foreground did not leave the target app within 3
  seconds. The trigger may not actually open an external app.
- `SCENARIO_PACKAGE_MISMATCH`: the escaped package is not in the known system
  list for the scenario. Use `custom` with `--description` to bypass.
- `BRIDGE_NOT_RETURNED`: the foreground did not return within
  `returnTimeoutMs`. The user may need more time, or the external app hung.

A successful bridge step returns `nextBinding` and `nextSnapshotRef` like any
other step. Continue the generation loop from that post-return state. The
committed Journey step carries `replayMode: "manual"`, so during `finalize`
replay a human operator must complete the external action before the return
timeout.

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

| Situation              | Action                                      |
|------------------------|---------------------------------------------|
| Doctor fails           | Stop, report environment issue              |
| Context validation fails | Fix JSON, retry validation                |
| Step rejected before execution | Re-observe + re-generate (up to retryCount) |
| PACKAGE_ESCAPE on step | Use `generation bridge` for cross-app flows |
| Bridge no escape / mismatch / not returned | Check trigger, scenario, or timeout; retry or use `custom` |
| Confirmation required  | Present to user, wait for approval          |
| Recovery required      | Inspect status; ask before retry; re-observe |
| Config changed         | Start a new session; never rebind in place  |
| Max steps exceeded     | Stop, report incomplete Goal                |
| Finalize not verified  | Report failure detail, do not claim success |

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
- SHA-256 hashes are ALWAYS computed via shell, never guessed.
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
  AGP 7+). `namespace` is for R class generation and may differ from
  `applicationId`. If `applicationId` is a variable reference (e.g.,
  `gradle.ext.buildApplicationId`), trace it through `gradle.properties`
  and any `.gradle` config files to find the actual string value. Include
  project-wide identity/catalog files in the root `manifest.files`; put
  module-owned files in that module shard's `manifest.files`.
- The `resourceId` in locators is the bare name without the `id/` prefix
  (e.g., `open_search`, not `id/open_search`).
- The same `@+id/submit` can appear in multiple layout XML files — this is
  normal, not a conflict. Only one layout is active at runtime; always
  match against the `observe` snapshot, not static XML.
- `activity.after` is NOT included in proposed steps. The Core determines
  it from live observation. Including it will cause validation failure.
- `inputText` steps do not include a `locator` — the Core uses the
  currently focused element.
- `confirmationRequired` steps require an explicit human decision. Local
  terminals may omit `--decision` for a TTY prompt. Sandboxed callers may use
  the exact challenge-bound `--decision approve|decline` only after relaying
  the challenge and receiving that decision; the agent must NOT auto-approve.
- `generation status --json` exposes `pendingConfirmation.expired`. While a
  challenge remains pending, `observe` returns
  `RISK_CONFIRMATION_REQUIRED`, not a retryable observation failure. An
  expired challenge cannot be approved; clear it with the exact challenge ID
  and `--decision decline`, then observe and propose again.
- `confirmationRequiredActions` in the interaction policy is
  per-action-TYPE, not per-element. Listing `click` means EVERY click in
  the app requires human approval during generation. Leave empty unless
  ALL instances of that action are genuinely dangerous. The Core risk
  evaluator handles per-step risk assessment at runtime.
- If `context status` returns `"stale"`, run `context refresh --json` first.
  When it reports `"refreshed"` the Context is current again. When it reports
  `"blocked"`, read each block's `resolution` field and act on it — do NOT
  blanket re-analyze. `pruneDeleted` → `--prune-deleted`;
  `acceptSourceChanges` → `--accept-source-changes` (only re-analyze when the
  module summary is now wrong or new UI files were added); `reanalyze` →
  Phase 1 for that module. A stale Context will cause `generation start` to
  fail with `CONTEXT_STALE`.
- `finalize` performs a full replay from scratch (forceStop, relaunch).
  TapHound does not build or install the APK; ensure the app is installed
  before calling `finalize`. It is not incremental. Prefer `--detach` and
  `generation status --wait`; do not call it until all steps are complete.
- **Context completeness is explicit**: every discovered Gradle module must
  have a catalog entry and shard status. A large project is handled as many
  bounded module analyses, never by silently omitting later feature modules.
- `settings.gradle` may use custom functions like `includeModule()` that
  dynamically include modules. Parsing `include` statements alone will
  miss these. Use `./gradlew projects` or `find . -name "build.gradle"
  -not -path "*/build/*"` as a filesystem fallback.
- Module inventory hashes detect new and deleted manifest, source, layout,
  and navigation files. A new Gradle module also changes root project
  evidence such as `settings.gradle(.kts)`.
- During generation, if `observe` returns an Activity not covered by the
  session's selected module shards, stop and report a Context coverage gap.
  Do not add modules after start because `contextSelection` is bound to the
  authoritative session.
- `PACKAGE_ESCAPE` from `generation step` means the action would leave the
  target app. Switch to `generation bridge` with the appropriate scenario
  instead of retrying the same proposal. Bridge steps commit with
  `replayMode: "manual"`, so during `finalize` replay a human operator must
  complete the external action before `returnTimeoutMs` expires.
- `generation bridge` with `--scenario custom` skips system package validation
  but requires `--description`. Use it for third-party apps or non-standard
  pickers. Built-in scenarios (`photoCapture`, `pickImage`, `pickFile`) validate
  the escaped package against a known list and fail with
  `SCENARIO_PACKAGE_MISMATCH` on mismatch.
