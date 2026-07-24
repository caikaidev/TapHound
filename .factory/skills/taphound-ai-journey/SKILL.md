# TapHound AI Journey Skill

Platform-neutral instructions for any AI agent (Droid, Claude Code, Cursor,
etc.) to drive TapHound's deterministic generation protocol end-to-end.

## Skill Directory

All file references in this document are relative to the Skill directory:

```
.factory/skills/taphound-ai-journey/
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
`.factory/skills/taphound-ai-journey/prompts/analyze-project.md` (relative
to the repository root that contains the `.factory/` directory).

## How to Use This Skill

This Skill lives at `.factory/skills/taphound-ai-journey/`. Entry point is
`SKILL.md`.

- **Droid**: This Skill is automatically discovered from `.factory/skills/`.
  Invoke it with the Skill tool when the user wants to generate or verify
  an Android journey via AI-driven generation.
- **Claude Code**: Add `@.factory/skills/taphound-ai-journey/SKILL.md` to
  your `CLAUDE.md`, or load it directly in the session.
- **Cursor / other tools**: Import this directory as a rules or instructions
  source. The agent needs to: read files, execute shell commands, and
  generate JSON matching the provided schemas.

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
3. Run:
   ```bash
   taphound doctor --project <project> --json
   ```
   Confirm `"status": "passed"`. Capture `deviceSerial` from the result.
   If `device` was supplied, use it; otherwise use the doctor's selection.
   If doctor fails, stop and report the failure.

## Phase 1: Project Context Generation

1. Read `prompts/analyze-project.md` for analysis guidance.
2. Read the Android project source files:
   - `AndroidManifest.xml`
   - Kotlin/Java source under `app/src/main/java/`
   - Layout XML under `app/src/main/res/layout/`
3. Extract:
   - `packageName` and `launchActivity` from the manifest.
   - UI element `resourceId` values from layout XML (`@+id/<name>` →
     `<name>`).
   - Logcat tags and patterns from source (`Log.i("Tag", "pattern")`).
   - Actionable elements and their supported actions.
4. Compute SHA-256 for each file you include in the manifest:
   ```bash
   node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<project>/<relative-path>')).digest('hex'))"
   ```
   NEVER guess a hash. Always compute it.
5. Generate the Project Context JSON matching `schemas/project-context.json`.
   Use `templates/project-context.example.json` as a reference.
6. Write it to `<project>/.taphound/context/project-context.json`.
7. Validate:
   ```bash
   taphound context validate \
     --project <project> \
     --context <project>/.taphound/context/project-context.json \
     --json
   ```
8. If validation fails, read the error message, fix the JSON, and retry.
   Common failures:
   - Package name mismatch between manifest and Context.
   - Stale or incorrect SHA-256 hash.
   - Path containing `..` or starting with `/`.
   - File listed in manifest but not found on disk.

## Phase 2: Journey Generation

1. Start a generation session:
   ```bash
   taphound generation start \
     --project <project> \
     --config <config> \
     --context <project>/.taphound/context/project-context.json \
     --device <serial> \
     --json
   ```
   Capture `generationId` from the result. The `config` path is relative to
   the project root.

2. Initialize a `completedSteps` list (empty at start).

3. **Loop** for up to `maxSteps` iterations:

   a. **Observe** the current device state:
      ```bash
      taphound generation observe \
        --project <project> \
        --session <generationId> \
        --device <serial> \
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
     --context <project>/.taphound/context/project-context.json \
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
