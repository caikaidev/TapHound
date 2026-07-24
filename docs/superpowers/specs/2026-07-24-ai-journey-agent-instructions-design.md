# TapHound AI Journey Agent Instructions — Design

Date: 2026-07-24
Status: Approved

## Goal

Provide a platform-neutral agent instruction package that lets any AI agent
tool (Droid, Claude Code, Cursor, etc.) drive the TapHound generation protocol
end-to-end: analyze an Android project to produce a Project Context, generate
test steps from a user-supplied Goal, execute them through the Core CLI, and
finalize a verified Journey.

## Platform Neutrality

The package is a directory of markdown instructions, JSON Schemas, and prompt
templates. It does not depend on any specific agent platform's loading
mechanism. To use it:

- **Droid:** place under `.factory/skills/` or point a Skill at the directory.
- **Claude Code:** reference `INSTRUCTIONS.md` from `CLAUDE.md` or load it
  directly.
- **Cursor / other tools:** import the directory as a rules/instructions source.

The only requirements on the agent are: read files, execute shell commands,
and generate JSON matching provided schemas.

## File Structure

```
.factory/skills/taphound-ai-journey/
├── SKILL.md                           # Main orchestration entry point
├── GUIDE.md                           # Detailed step-by-step usage guide
├── schemas/
│   ├── project-context.json           # ProjectContextSchema as JSON Schema
│   ├── proposed-step-envelope.json    # {version, proposal, snapshot} envelope
│   └── observe-output.json            # generation observe --json output shape
├── prompts/
│   ├── analyze-project.md             # How to analyze source for Context
│   ├── generate-step.md               # How to generate next step from Goal+snapshot
│   └── check-completion.md            # How to decide Goal is fulfilled
└── templates/
    └── project-context.example.json   # Full Context example
```

## Execution Flow

### Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| `project` | yes | Android project root path |
| `goal` | yes | Natural-language test scenario description |
| `config` | no | TapHound config path (default `taphound.config.json`) |
| `device` | no | Device serial (default: let doctor select) |
| `output` | no | Output journey path (default `journeys/generated.json`) |
| `maxSteps` | no | Max generation steps (default 30) |
| `retryCount` | no | Retries per rejected step (default 3) |

### Phase 0: Preflight

1. Verify `dist/cli/main.js` exists; if not, run `npm run build`.
2. Run `adb devices -l`; confirm at least one online device.
3. Run `node dist/cli/main.js doctor --project <project> --json`; confirm
   `status: "passed"` and capture `deviceSerial`.
4. If `device` was supplied, use it; otherwise use doctor's selection.

### Phase 1: Project Context Generation

1. Read `prompts/analyze-project.md` for analysis guidance.
2. Read and analyze:
   - `AndroidManifest.xml` (extract `packageName`, `launchActivity`).
   - Kotlin/Java source files (identify Activities, click handlers, UI logic).
   - Layout XML files (extract `android:id` resources as locator candidates).
   - Logcat tag/level usage in source for expectation candidates.
3. Compute SHA-256 for each file included in the manifest using:
   ```bash
   node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<path>')).digest('hex'))"
   ```
   Do not guess hashes; always compute.
4. Generate Project Context JSON matching `schemas/project-context.json`.
   - `interactionPolicy.allowedActions`: include only actions the project's UI
     actually uses (not necessarily all seven).
   - `confirmationRequiredActions`: actions that modify server-side state
     (submit, send, delete). If unclear, leave empty for first phase.
   - `forbiddenActions`: destructive/irreversible actions. If none, leave empty.
5. Write to `<project>/.taphound/context/project-context.json`.
6. Validate:
   ```bash
   node dist/cli/main.js context validate \
     --project <project> --context <path> --json
   ```
7. If validation fails, read the error, fix the JSON, and retry. Common
   failures: wrong package name, stale hash, path traversal, missing files.

### Phase 2: Journey Generation

1. Start session:
   ```bash
   node dist/cli/main.js generation start \
     --project <project> --config <config> --context <path> \
     --device <serial> --json
   ```
   Capture `generationId` from the JSON result.

2. For each step (up to `maxSteps`):

   a. **Observe** current device state:
      ```bash
      node dist/cli/main.js generation observe \
        --project <project> --session <id> --device <serial> --json
      ```
      Capture the full `snapshot` object and `binding`
      (`generationId`, `baseRevision`, `snapshotHash`).

   b. **Generate proposed step**: read `prompts/generate-step.md`, then
      produce a proposed step JSON object based on:
      - The user's Goal (what remains to be accomplished).
      - The Project Context (known UI elements, locators).
      - The snapshot's `layout` array (what's currently on screen).
      - The snapshot's `activity` (current Activity class).
      - Previously completed steps (track progress toward Goal).

      The proposed step must match `schemas/proposed-step-envelope.json` when
      wrapped with the snapshot and binding.

   c. **Check completion**: read `prompts/check-completion.md`. If the AI
      determines the Goal is fully accomplished, break out of the loop and
      proceed to Phase 3.

   d. **Write envelope** to a temp file:
      ```json
      {
        "version": 1,
        "proposal": { ...step..., "binding": {generationId, baseRevision, snapshotHash} },
        "snapshot": { ...full observe snapshot... }
      }
      ```

   e. **Execute step**:
      ```bash
      node dist/cli/main.js generation step \
        --project <project> --session <id> --input <envelope-path> --json
      ```

   f. **Handle result**:
      - `status: "succeeded"` — record the step, continue to next iteration.
      - `status: "confirmationRequired"` — present the challenge to the user.
        Wait for explicit approval, then run `generation confirm --session <id>
        --challenge <challengeId> --json`. Do not auto-approve.
      - `status: "error"` with any failure code — read the failure message.
        Decrement retry budget. If retries remain, re-observe and re-generate
        the step with the failure feedback. If retries exhausted, stop and
        report the failure with the session ID.
      - `status: "recoveryRequired"` — the session is in a recovery state.
        Stop and report; the user must decide whether to recover or abandon.

3. Clean up the temp envelope file after each step.

### Phase 3: Finalize

1. Run finalize:
   ```bash
   node dist/cli/main.js generation finalize \
     --project <project> --session <id> --context <path> \
     --output <output> --device <serial> --json
   ```

2. Check `status`:
   - `"verified"` — success. Report `bundlePath`, `journeyPath`, `metaPath`,
     `replayed`.
   - Any other status — failure. Report the failure detail and session ID.
     Do not claim success.

3. Clean up temp files.

## Prompt Design

### `prompts/analyze-project.md`

Instructs the AI to:
- Identify the launch Activity from AndroidManifest.xml.
- Map `android:id` values to Locator candidates (`resourceId` field).
- Extract `android:text` and `android:contentDescription` as fallback locator
  candidates.
- Identify Logcat tags and log patterns from source code (`Log.i(tag, ...)`
  calls).
- Determine which actions the UI supports (click buttons, input text in
  EditText, swipe in scrollable containers, back navigation).
- Classify actions by risk (safe / confirmationRequired / forbidden) based on
  business semantics.

### `prompts/generate-step.md`

Instructs the AI to:
- Compare the Goal against completed steps to determine what remains.
- Examine the snapshot layout for actionable elements matching the next
  intended action.
- Choose a locator using priority: `resourceId` > `text` >
  `contentDescription`.
- Set `activity.before` to the snapshot's current activity.
- Predict `activity.after` based on the action (navigation click → target
  Activity; input/click same screen → same Activity).
- Add `expect` only if there is a deterministic, verifiable outcome (element
  appears, logcat pattern).
- Never use coordinates, visual guessing, or fallback annotations.
- Output a single proposed step JSON object (without binding; the envelope
  wrapper adds binding).

### `prompts/check-completion.md`

Instructs the AI to:
- List the Goal's implied sub-tasks.
- Check each against completed steps.
- Return `{"complete": true}` if all sub-tasks have succeeding steps, or
  `{"complete": false, "remaining": "..."}` otherwise.

## Schema Files

The three JSON Schema files are derived from the TapHound Core's Zod schemas
(`src/domain/project-context.ts`, `src/domain/proposed-step.ts`,
`src/domain/runtime-snapshot.ts`). They are plain JSON Schema Draft 2020-12,
not Zod, so any agent can validate against them without TypeScript tooling.

## Constraints

- No changes to TapHound Core code.
- No executable code; this is an instruction and schema package only.
- SHA-256 must be computed via shell, never guessed by the AI.
- `confirmationRequired` always requires human approval; the agent never
  auto-approves.
- The agent never bypasses Core safety boundaries (package guard, risk policy,
  locator uniqueness).
- `maxSteps` and `retryCount` prevent infinite loops.
- Temp files are cleaned up after each step and at the end.

## Success Criteria

An AI agent (Droid, Claude Code, or other) reading `INSTRUCTIONS.md` can:

1. Generate a valid Project Context for `examples/taphound-android-demo` that
   passes `context validate`.
2. Given the Goal "test search: click open search, input hello world, submit,
   verify logcat", generate and execute 3-4 proposed steps through the
   generation CLI.
3. Finalize to a `status: "verified"` Journey with an exported
   `generated-search.json` and sidecar meta.
4. The resulting Journey is a valid Journey v1 that can also pass ordinary
   `taphound verify`.
