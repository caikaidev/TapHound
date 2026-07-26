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
│   ├── generate-step.md                  # Phase 2: next-step generation guidance
│   └── check-completion.md               # Phase 2: Goal completion check
├── schemas/
│   ├── project-context.json              # ProjectContext JSON Schema
│   ├── proposed-step-envelope.json       # {version, proposal, snapshot} envelope
│   └── observe-output.json               # generation observe --json output shape
└── templates/
    └── project-context.example.json      # Full Context example
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

| Parameter  | Required | Default                        | Description                          |
|------------|----------|--------------------------------|--------------------------------------|
| project    | yes      | —                              | Android project root path            |
| goal       | yes      | —                              | Natural-language test scenario       |
| config     | no       | `taphound.config.json`         | TapHound config path (relative to project) |
| device     | no       | doctor selects                  | Device serial                        |
| output     | no       | `journeys/generated.json`      | Output journey path (relative to project) |
| maxSteps   | no       | 30                             | Maximum generation steps             |
| retryCount | no       | 3                              | Retries per rejected step            |

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
   - `"valid"`: Hashes match. Do a quick structural check (Step 5) to
     detect new files not in the manifest.
   - `"stale"`: Tracked files changed. Needs incremental update or full
     regeneration (see GUIDE.md Section 5).
   - `"invalid"`: Needs full regeneration.
   - If the file does not exist, proceed to Phase 1 (full generation).

5. **Structural completeness check** (when status is `"valid"`):
   `context status` only checks hashes of files already listed — it
   cannot detect NEW files. Run a quick count comparison:
   ```bash
   # Count Activity source files on disk
   find <project> \( -name "*.kt" -o -name "*.java" \) \
     -not -path "*/build/*" \
     -exec grep -l "extends.*Activity\|:.*Activity(" {} + | wc -l
   ```
   Compare with the number of Activity source files in the Context's
   `manifest.files`. If the on-disk count is higher, new Activities were
   added — proceed to Phase 1 for full regeneration.

   If both status and structural check pass, skip Phase 1 and go directly
   to Phase 2.

## Phase 1: Project Context Generation

> Read `prompts/analyze-project.md` before starting — it contains detailed
> guidance on multi-module discovery, packageName resolution, and complex
> layout structures. Read `schemas/project-context.json` to understand the
> required JSON structure. Use `templates/project-context.example.json`
> as a reference template.

1. Analyze the Android project source per `prompts/analyze-project.md`:
   - Discover modules via `./gradlew projects` (fallback: parse
     `settings.gradle`).
   - Determine `applicationId` from the app module's build file.
   - Identify the launch Activity from the app module's manifest.
   - Scan all modules for Activities, click handlers, Logcat tags, layout
     XML (resolving `<include>`, `<merge>`, `<layout>`, `<ViewStub>`).
2. Compute SHA-256 for each file you include in the manifest:
   ```bash
   node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<project>/<relative-path>')).digest('hex'))"
   ```
   NEVER guess a hash. Always compute it.
3. Generate the Project Context JSON matching `schemas/project-context.json`.
4. Write it to `<project>/.taphound/context/project-context.json`.
5. Validate:
   ```bash
   taphound context validate \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```
6. If validation fails, read the error message, fix the JSON, and retry.
   Common failures:
   - Package name mismatch between `taphound.config.json` and Context.
   - Stale or incorrect SHA-256 hash.
   - Path containing `..` or starting with `/`.
   - File listed in manifest but not found on disk.

## Phase 2: Journey Generation

> Read `schemas/proposed-step-envelope.json` to understand the envelope
> structure before building step proposals. Read `prompts/generate-step.md`
> for element-matching and step-generation guidance. Read
> `prompts/check-completion.md` for Goal-completion criteria.

1. Start a generation session:
   ```bash
   taphound generation start \
     --project <project> \
     --config <config> \
     --context .taphound/context/project-context.json \
     --device <serial> \
     --json
   ```
   Capture `generationId` from the result. The `config` path is relative to
   the project root. The selected device is bound to this session; subsequent
   `observe`, `step`, `confirm`, and `manual` commands use the session binding
   and do not accept `--device`.

2. Initialize a `completedSteps` list (empty at start).

3. **Loop** for up to `maxSteps` iterations:

   a. **Observe** the current device state:
      ```bash
      taphound generation observe \
        --project <project> \
        --session <generationId> \
        --json
      ```
      Parse the result. Capture:
      - `generationId`, `baseRevision`, `snapshotHash` (the binding).
      - `snapshot` (the full RuntimeSnapshot object, including `layout`).

   b. **Check completion**: Read `prompts/check-completion.md`. Using the
      Goal and `completedSteps`, determine if the Goal is accomplished.
      If `{"complete": true}`, break out of the loop and go to Phase 3.

   c. **Generate proposed step**: Read `prompts/generate-step.md`. Using the
      Goal, Project Context, `snapshot.layout`, and `snapshot.activity`,
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
        --json
      ```

   f. **Handle the result**:
      - **`status: "succeeded"`**: Add the step to `completedSteps`. Clean
        up the temp file. Continue to the next iteration.
      - **`status: "confirmationRequired"`**: Present the challenge details
        (action summary, challenge ID) to the user. Wait for explicit
        human approval. If approved, run:
        ```bash
        taphound generation confirm \
          --project <project> \
          --session <generationId> \
          --challenge <challengeId> \
          --json
        ```
        Do NOT auto-approve. If the user declines, stop and report.
      - **`status: "error"` (any failure code)**: Read the failure code and
        message. Decrement the retry budget for this step.
        - If retries remain: re-observe (go back to step a) and re-generate
          the step, this time accounting for the failure feedback (e.g., if
          the locator was not found, try a different locator; if the
          activity was wrong, adjust the prediction).
        - If retries are exhausted: stop and report the failure with the
          session ID, last error, and step index.
      - **`status: "recoveryRequired"`**: The session is in a crash-
        consistent recovery state. Stop and report. The user must decide
        whether to recover or abandon. Do not attempt further steps.

   g. Clean up the temp envelope file after each iteration (success or
      failure).

## Phase 3: Finalize

1. Run finalize:
   ```bash
   taphound generation finalize \
     --project <project> \
     --session <generationId> \
     --context .taphound/context/project-context.json \
     --output <output> \
     --device <serial> \
     --json
   ```

2. Check the result `status`:
   - **`"verified"`**: Success. Report to the user:
     - `bundlePath` (authoritative generation bundle)
     - `journeyPath` (exported Journey v1)
     - `metaPath` (sidecar meta with verification evidence)
     - `replayed` (should be `true`)
   - **Any other status**: Failure. Report the failure detail and session
     ID. Do NOT claim success. The session may still be recoverable.

3. Clean up any remaining temp files.

## Error Handling Summary

| Situation              | Action                                      |
|------------------------|---------------------------------------------|
| Doctor fails           | Stop, report environment issue              |
| Context validation fails | Fix JSON, retry validation                |
| Step rejected          | Re-observe + re-generate (up to retryCount) |
| Confirmation required  | Present to user, wait for approval          |
| Recovery required      | Stop, report session ID                     |
| Max steps exceeded     | Stop, report incomplete Goal                |
| Finalize not verified  | Report failure detail, do not claim success |

## Key Rules

- The agent NEVER auto-approves a confirmation challenge.
- The agent NEVER bypasses Core safety (package guard, risk policy, locator
  uniqueness).
- SHA-256 hashes are ALWAYS computed via shell, never guessed.
- The agent does NOT modify TapHound Core source code.
- The agent does NOT use coordinates, visual guessing, or fallback.
- Locator priority is fixed: `resourceId` > `text` > `contentDescription`.
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
  all files in the resolution chain in `manifest.files`.
- The `resourceId` in locators is the bare name without the `id/` prefix
  (e.g., `open_search`, not `id/open_search`).
- The same `@+id/submit` can appear in multiple layout XML files — this is
  normal, not a conflict. Only one layout is active at runtime; always
  match against the `observe` snapshot, not static XML.
- `activity.after` is NOT included in proposed steps. The Core determines
  it from live observation. Including it will cause validation failure.
- `inputText` steps do not include a `locator` — the Core uses the
  currently focused element.
- `confirmationRequired` steps must be approved by a human in a TTY
  terminal. The agent must NOT auto-approve.
- `confirmationRequiredActions` in the interaction policy is
  per-action-TYPE, not per-element. Listing `click` means EVERY click in
  the app requires human approval during generation. Leave empty unless
  ALL instances of that action are genuinely dangerous. The Core risk
  evaluator handles per-step risk assessment at runtime.
- If `context status` returns `"stale"`, the Context must be regenerated
  before starting a new generation session. A stale Context will cause
  `generation start` to fail with `CONTEXT_STALE`.
- `finalize` performs a full replay from scratch (forceStop, rebuild,
  relaunch). It is not incremental. Do not call it until all steps are
  complete.
- **Context completeness is critical**: the Context must include ALL
  Activity source files and their layouts across ALL modules. If the AI
  only scans a few files, the Context is useless for staleness detection
  and the AI will not know about screens it missed. Use shell commands
  (`find . -name AndroidManifest.xml -not -path "*/build/*"`) to
  systematically discover all modules and Activities.
- `settings.gradle` may use custom functions like `includeModule()` that
  dynamically include modules. Parsing `include` statements alone will
  miss these. Use `./gradlew projects` or `find . -name "build.gradle"
  -not -path "*/build/*"` as a filesystem fallback.
- `context status` only detects content changes to files already listed
  in the Context. It does NOT detect new files added to the project (new
  Activities, new layouts, new modules). Always run a structural count
  comparison before reusing a Context.
- During generation, if `observe` returns unexpected elements or
  Activities not known from the Context, the Context may be stale. Note
  the discrepancy, adapt to the live state, and recommend a Context
  update after the session. Do NOT abort unless the error is
  unrecoverable.
