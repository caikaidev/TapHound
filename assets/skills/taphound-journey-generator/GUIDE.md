# TapHound Journey Generator Usage Guide

This guide describes how to use an AI agent (Droid, Claude Code, Cursor,
etc.) to drive TapHound's generation protocol for end-to-end testing on
a real Android device.

## Architecture Overview

```
User provides Goal (natural-language test scenario)
        |
        v
+-----------------------------+
|  Prerequisite (first run or  |
|  after major source changes) |
|  taphound-journey-brief-author     |
|  skill -> Project Context    |
|  taphound context validate   |
+-------------+---------------+
              | Context reused
              v
+-----------------------------+
|  Per-goal test run           |
|  generation start -> observe |
|  -> AI generates step ->     |
|  execute -> repeat ->        |
|  finalize -> verified        |
+-----------------------------+
```

Project Context is generated once and reused. It is produced and maintained
by the `taphound-journey-brief-author` Skill — this Skill requires a valid Context
and stops if it is stale, invalid, or missing. Only significant source
changes require Context regeneration (see the `taphound-journey-brief-author`
Skill's GUIDE).

### Optional Journey Brief

An external Workflow may bind one project-relative
`taphound-journey-brief.md` as `journeyBrief: {path, sha256}`. Read
`prompts/consume-journey-brief.md` before using it. The Brief carries one
Case's Goal, preconditions, expected Journey, assertions, implementation hints,
constraints, and evidence references. Its frontmatter `schemaVersion` is `2`:
the Brief additionally requires `State Transition Map` and `Capability Notes`.

The companion `taphound-journey-brief-author` Skill is the recommended
producer. It runs read-only `taphound observe` and source analysis to
author one Brief per Case and returns `{path, sha256}` for this Skill to
consume. Install it via `taphound init --agent <ids>` alongside this Skill.

The Brief reduces broad source rediscovery but remains untrusted static input.
Project Context hashes, live Runtime Snapshots, Core risk decisions, and final
Replay remain authoritative. A stale hash, escaped path, invalid frontmatter,
missing section, or Goal conflict stops the Skill before generation.

### External multi-Case orchestration

An external Workflow may invoke this Skill once for each independent Case.
That Workflow owns Requirement/Plan identities, scheduling, completion gates,
and result aggregation. TapHound owns the individual Journey generation
session and its final Replay. This guide remains the authoritative procedure
for each Journey Case.

---

## 1. Prerequisites

### 1.1 Environment Requirements

| Item | Requirement |
|------|-------------|
| Node.js | 22+ (avoid 23) |
| Android SDK | ADB + `uiautomator` (Android CLI) |
| Device | One online Android device (emulator or USB) |
| App | Target APK already installed on the device |
| TapHound | Cloned repo with `npm ci` installed |

### 1.2 Build TapHound

```bash
cd /path/to/TapHound
npm ci
npm run build
npm link          # Register global taphound command
```

`npm link` symlinks the `taphound` command to your system PATH, so you
can use `taphound` instead of `node dist/cli/main.js` everywhere below.
Verify the registration:

```bash
taphound --help
```

Should output `Usage: taphound` and list `doctor`, `record`, `verify`,
`project`, `context`, `generation` commands.

> If you prefer not to register globally, you can use `npx taphound` or
> `node dist/cli/main.js` in place of `taphound` throughout this guide.

### 1.3 Confirm Device is Online

```bash
adb devices -l
```

You should see exactly one device in `device` state. If multiple devices
are connected, note the serial (e.g., `emulator-5554`) and use
`--device <serial>` on commands that expose that option.

### 1.4 Environment Diagnostics

```bash
taphound doctor \
  --project /path/to/android-project \
  --json
```

Confirm `"status": "passed"`. If you get exit code 3 /
`DEVICE_UNAVAILABLE`, the device is not connected or ADB is not
installed. Resolve the environment issue first.

---

## 2. Project Context Setup (Prerequisite)

> Project Context describes the Android project's UI structure, element
> locators, and interaction policy. It is generated once, persisted in the
> project directory, and reused for every Journey generation run.

This Skill requires a valid Project Context as a prerequisite. The
`taphound-journey-brief-author` Skill is the recommended producer — it analyzes
Android source and maintains the Context Bundle using
`taphound context generate`, `context refresh`, `context rehash`, and
`context validate`.

Before each generation session, this Skill checks Context currency via
`taphound context status`. If the Context is stale, invalid, or missing,
this Skill stops and requires `taphound-journey-brief-author` to run first.

To generate or update the Context, invoke the `taphound-journey-brief-author`
Skill:

```
Generate a TapHound Project Context for the project at /path/to/android-project.
```

See the `taphound-journey-brief-author` Skill's `CONTEXT-GUIDE.md` for the full Context
generation, incremental update, and regeneration procedures.

---

## 3. Per-Goal Test: Generate a Journey

> Each Goal is an independent test scenario. The same Project Context can
> drive multiple different Goals.

### 3.1 Provide a Test Goal

Describe the scenario you want to test in natural language, for example:

```
Test the search feature: click the search button to open the search page,
type "hello world" in the search box, click submit, and verify the log
shows "submitted query=hello world".
```

### 3.2 Select a Reusable Flow

Before each Goal, inspect the project-local Flow catalog:

```bash
taphound journey list-flows \
  --project /path/to/android-project \
  --json
```

Read `prompts/select-flow.md`. Choose the deepest `status: \"valid\"` Flow
whose `exitActivity` is a prerequisite for the Goal. For a Goal inside chat
detail, prefer `chat/open-thread` over `core/launch-home` when both are
valid. Never select only because a filename contains a Goal keyword.

The first resolved step must start from a stable Activity that cold launch
deterministically reaches. The configured `run.activity` is only the launch
entry and may redirect immediately. Do not make a transient Splash Activity
remaining foreground a Flow precondition. A launch anchor should instead use
the stable destination and a unique readiness element:

```json
{
  "version": 1,
  "kind": "flow",
  "name": "core/launch-home",
  "includes": [],
  "steps": [{
    "action": "wait",
    "activity": {
      "before": "com.example.app.HomeActivity",
      "after": "com.example.app.HomeActivity"
    },
    "expect": {
      "type": "element",
      "locator": { "resourceId": "home_root" },
      "timeoutMs": 3000
    }
  }]
}
```

If a reusable prefix is selected, keep its name for the next command. If no
Flow applies, continue without `--base-flow`.

### 3.3 Step 1 — Start a Generation Session

```bash
taphound generation start \
  --project /path/to/android-project \
  --config .taphound/config.json \
  --context .taphound/context/project-context.json \
  --module :feature:search \
  --device emulator-5554 \
  --base-flow search/open \
  --json
```

Omit `--base-flow` when no existing Flow applies. With a base Flow, Core first
cold-launches and exactly replays the resolved prefix. A clean replay becomes
the immutable candidate prefix, and the first `observe` starts from the Flow's
exit Activity.

**Output** (`--json` mode writes exactly one JSON object to stdout):

```json
{
  "status": "started",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "revision": 0,
  "bindings": { "projectHash": "...", "configHash": "...", "contextHash": "...", "snapshotHash": null },
  "contextSelection": { "bundleVersion": 2, "indexHash": "...", "modules": [{"id": ":app", "sha256": "...", "projectDir": "app", "inventory": {"pathSetSha256": "...", "categories": ["manifests", "sources", "layouts", "navigation"]}}, {"id": ":feature:search", "sha256": "...", "projectDir": "features/search", "inventory": {"pathSetSha256": "...", "categories": ["manifests", "sources", "layouts", "navigation"]}}] },
  "variables": { "runId": "...", "timestamp": "...", "randomHex": "..." },
  "target": { "packageName": "...", "deviceSerial": "...", "resetStrategy": "processOnly", "interactionPolicy": {...} }
}
```

**Note the `generationId` and `contextSelection`**. The application module,
requested modules, and their declared dependencies are bound to the session.
Omitting `--module` selects all modules. Modules cannot be added after start.
The selected device is also bound. Session operations such as `observe`,
`step`, `confirm`, and `manual` do not accept `--device`.
Without `--base-flow`, Core force-stops, launches the configured Activity, and
waits for the App process before creating the session. The first observation's
idle/layout checks determine the stable post-redirect start state. With a Base
Flow, the verified replay prepares the bound post-Flow state. Launcher
navigation is never a Journey step.

**Failure troubleshooting**:

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 2 | `CONFIG_INVALID` / `CONTEXT_INVALID` / `FLOW_INVALID` | Check config, Context, and Flow files |
| 1 | `CONTEXT_STALE` | Source changed; run `taphound-journey-brief-author` skill to update Context |
| 1 | `FLOW_REPLAY_FAILED` | Inspect `details` (Flow, Verify report, primary failure, failed step, recovery), then repair/re-record the Flow; do not silently bypass it |
| 3 | Environment issue | Run `doctor` first |
| 4 | Internal error | Check stderr output |

For `FLOW_REPLAY_FAILED`, first check whether the Flow starts at a stable
cold-launch destination. Replace a timing-sensitive Splash transition with a
Home readiness anchor when appropriate, without guessing from Activity names.
The fact that the device currently shows Home does not make the failed replay
exact. Omit `--base-flow` and restart only after the user explicitly chooses
to bypass reuse.

### 3.4 Step 2 — Observe Current Device State

```bash
taphound generation observe \
  --project /path/to/android-project \
  --session <generationId> \
  --compact \
  --json
```

**Output**:

```json
{
  "status": "observed",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "baseRevision": 1,
  "snapshotHash": "e5f6...",
  "snapshotRef": ".taphound/build/generations/.a1b2c3d4-...work/evidence/snapshots/revision-000001/attempt-.../snapshot.json"
}
```

**Note** three binding fields: `generationId`, `baseRevision`,
`snapshotHash`, plus `snapshotRef`. Runtime Snapshot v2 also binds the exact
`uiBackend`, physical-display `viewport`, observation ID, and capture duration.
Do not replace it with a snapshot from another backend. Read that project-relative authoritative
JSON file as the full `snapshot` object required by the proposed-step
envelope. Running without `--compact` also includes the same snapshot inline,
but still returns `snapshotRef`. Active sessions use the Store-owned hidden
bundle `.<generationId>.work`; successful final publication atomically moves
the same evidence to `<generationId>`, so callers must use the reference Core
returns rather than constructing a path. Current snapshots
also include `windowHierarchy` when the external tools expose enough
metadata. `complete` means visible touchable target-app windows are covered by
semantic roots, `unknown` means one side was unavailable, and `incomplete`
means TapHound observed more app windows than semantic roots
(`APP_WINDOW_WITHOUT_SEMANTIC_ROOT`), or observed a visible app window that
cannot take focus (`APP_WINDOW_NOT_ACCESSIBILITY_READABLE`). Android
accessibility only serializes the active window, so a non-focusable popup or
panel is never readable; that is an app-side defect, and the app must make the
window focusable in debug builds before the journey can continue.

When `windowHierarchy.status` is `incomplete`, Core rejects every proposed
action with `WINDOW_HIERARCHY_INCOMPLETE` before mutation. Re-observe once.
If the mismatch persists, inspect the screen with Android Studio Layout
Inspector for diagnosis, or use an opt-in debug WindowInspector backend when
available. Layout Inspector is not a TapHound runtime dependency. Never work
around the failure with absolute coordinates or screenshot guessing.

> Core prepares the initial app state during `generation start`. If the
> foreground later escapes the target app, `observe` records that state and
> the next proposed step is rejected with `PACKAGE_ESCAPE`. Use
> `generation bridge` to handle cross-app flows (camera, picker, share sheet)
> within a single committed step; see **Cross-Application Bridge** below.

### 3.5 Step 3 — AI Generates Next Proposed Step

The AI agent reads `prompts/generate-step.md` and is given:

- **Goal**: the user's test scenario description
- **Project Context Index** and the selected module shard summaries
- **Snapshot**: the observe output from Step 2 (including layout)
- **Completed steps**: the list of steps already succeeded in this session

The AI agent analyzes the current screen elements, decides the next action
based on the Goal, and outputs a proposed step JSON (without `binding`,
which the caller fills in).

For example, if currently on MainActivity and the Goal is to test search,
the AI might generate:

```json
{
  "action": "click",
  "locator": { "resourceId": "open_search" },
  "activity": { "before": "dev.taphound.demo.MainActivity" },
  "expect": {
    "type": "element",
    "locator": { "resourceId": "search_input" },
    "timeoutMs": 3000
  }
}
```

### 3.6 Step 4 — Build Envelope and Execute

Combine the AI-generated proposed step with the binding and snapshot into
a complete envelope:

```json
{
  "version": 1,
  "proposal": {
    "action": "click",
    "locator": { "resourceId": "open_search" },
    "activity": { "before": "dev.taphound.demo.MainActivity" },
    "expect": {
      "type": "element",
      "locator": { "resourceId": "search_input" },
      "timeoutMs": 3000
    },
    "binding": {
      "generationId": "<generationId from observe>",
      "baseRevision": "<baseRevision from observe>",
      "snapshotHash": "<snapshotHash from observe>"
    }
  },
  "snapshot": { "...full snapshot from observe..." }
}
```

Write to a temp file, then execute:

```bash
taphound generation step \
  --project /path/to/android-project \
  --session <generationId> \
  --input /tmp/taphound-step.json \
  --compact \
  --json
```

**Success**:

```json
{
  "status": "succeeded",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "revision": 3,
  "stepIndex": 0,
  "step": { "action": "click", "locator": {...}, "activity": {...} },
  "source": "planner",
  "nextBinding": {
    "generationId": "a1b2c3d4-...",
    "baseRevision": 4,
    "snapshotHash": "..."
  },
  "nextSnapshotRef": ".taphound/build/generations/a1b2c3d4-.../evidence/snapshots/revision-000004/attempt-.../snapshot.json",
  "timing": {
    "freshnessCheckMs": 25,
    "actionExecutionMs": 80,
    "idleWaitMs": 340,
    "postActionObservationMs": 90,
    "expectationMs": 0,
    "totalMs": 620,
    "nextObservationMs": 110
  }
}
```

When both `nextBinding` and `nextSnapshotRef` are present, read the reference
as the full snapshot and use both directly for the next envelope. They were
captured from the post-action state and authoritatively committed. If either
is absent, run `generation observe`. Phase timing distinguishes Core action
and idle time from caller/agent latency.

**Confirmation required** (if the action is selected by the interaction policy
or Core semantic risk evaluation):

```json
{
  "status": "confirmationRequired",
  "exitCode": 0,
  "challenge": {
    "challengeId": "xYz123...",
    "stepIndex": 0,
    "proposalHash": "...",
    "snapshotHash": "...",
    "actionSummary": "click submit_search on dev.taphound.demo.SearchActivity",
    "expiresAt": "2026-07-24T...",
    "status": "pending"
  }
}
```

Human confirmation is required. In a local terminal, omit `--decision` to use
the TTY prompt:

```bash
taphound generation confirm \
  --project /path/to/android-project \
  --session <generationId> \
  --challenge <challengeId> \
  --compact \
  --json
```

In a sandbox without PTY access, first present `actionSummary`, `challengeId`,
and `expiresAt` to the user. Only after the user explicitly approves that exact
challenge, run:

```bash
taphound generation confirm \
  --project /path/to/android-project \
  --session <generationId> \
  --challenge <challengeId> \
  --decision approve \
  --compact \
  --json
```

If the user declines, replace `approve` with `decline`; Core clears that exact
challenge and does not execute the action. The flag records delegated approval
but is not permission to auto-approve. Never infer a decision, reuse approval
for another challenge, or enable session-wide approval.

The `confirmationRequired` response omits `nextBinding` and
`nextSnapshotRef`. After approval executes successfully, the `confirm` result
is a normal successful step result and carries both fields in compact mode
when the post-action observation succeeded.

Before executing an approved action, Core atomically records the challenge ID
and `approvalMode` (`localTty` or `delegated`) in the in-flight attempt. The
same audit data is included in immutable step result evidence.

`generation status --json` reports the pending challenge with a computed
`expired` flag. A pending challenge blocks observation with
`RISK_CONFIRMATION_REQUIRED`. Expired challenges cannot execute; clear the
exact challenge with `--decision decline`, then observe and propose again.

**Rejected before an ambiguous action attempt**:

```json
{
  "status": "error",
  "exitCode": 1,
  "failure": {
    "code": "LOCATOR_NOT_FOUND",
    "message": "No element matched resourceId=search_button"
  }
}
```

On failure, the AI agent should read the error, re-observe (Step 2),
re-generate the step (Step 3) with a corrected locator, and retry. Up to
3 retries.

**Recovery required after an action attempt**:

```json
{
  "status": "recoveryRequired",
  "exitCode": 1,
  "generationId": "a1b2c3d4-...",
  "failure": {
    "code": "IDLE_TIMEOUT",
    "message": "Layout did not become stable before timeout",
    "details": {
      "idle": {
        "strategy": "hybrid",
        "backend": "uiautomator",
        "fallbackUsed": true,
        "frameActivityDetected": true,
        "polls": 30,
        "durationMs": 30000,
        "samplingDurationMs": 12000,
        "lastDiff": []
      }
    }
  }
}
```

The action may already have executed. Inspect `generation status`, ask the
user before `generation recover --decision retry`, then re-observe. Recovery
does not commit the interrupted action and does not return a snapshot. If the
new state shows that the old action executed, stop and start a clean session;
do not silently omit or repeat the action.

### 3.7 Step 5 — Repeat Until Goal is Complete

After each successful step, use its `nextBinding` and read
`nextSnapshotRef` for the new device state. Return to Step 2 (`observe`) only
when the post-action snapshot capture was unavailable, then continue to
Step 3 -> Step 4.

The AI agent checks whether the Goal is complete before each step (reads
`prompts/check-completion.md`). If complete, it breaks out of the loop.

**Loop limit**: default maximum 30 steps. If exceeded, stop and report
incomplete.

### 3.7.1 Cross-Application Bridge

When the Goal requires a cross-app flow — for example tapping a button that
opens the system camera, image picker, or file picker — a regular
`generation step` proposal fails with `PACKAGE_ESCAPE` because the foreground
leaves the target package. Use `generation bridge` instead.

Before starting a `photoCapture` generation, require a valid project-level
`camera/photo-capture` External Flow. The built-in flow targets one AOSP
Camera2 variant and must not be treated as device-generic. If the project flow
is missing or invalid, explain that alignment captures a real probe photo,
obtain explicit permission, and run:

```bash
taphound align camera \
  --project /path/to/android-project \
  --device <deviceSerial> \
  --json
```

Add `--force` only with explicit permission to replace an existing project
flow. Then run `journey list-flows --include-external --json` again and bind
the valid project flow in a new generation session. Alignment fails closed
with `ALIGN_CONFIRM_NOT_FOUND`, `ALIGN_CONFIRM_NO_RESOURCE_ID`, or
`ALIGN_CONFIRM_AMBIGUOUS` when it cannot produce deterministic confirm steps;
do not hand-wave those failures into a shutter-only or manual flow.

**Auto bridge** (deterministic, no operator): if an External Flow was bound at
`generation start --external-flow`, pass `--flow <name>` so Core resolves the
flow, stamps its steps as `externalSteps`, and commits with
`replayMode: "auto"`:

```bash
taphound generation bridge \
  --project /path/to/android-project \
  --session <generationId> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"camera_button"}' \
  --flow camera/photo-capture \
  --return-timeout-ms 60000 \
  --escape-timeout-ms 3000 \
  --compact \
  --json
```

**Manual bridge** (human operator completes the external action during replay):
omit `--flow`. The step commits with `replayMode: "manual"`:

```bash
taphound generation bridge \
  --project /path/to/android-project \
  --session <generationId> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"camera_button"}' \
  --return-timeout-ms 60000 \
  --compact \
  --json
```

Core clicks the trigger, detects the package escape, executes the External
Flow's steps (when `--flow` is supplied) inside the escaped package, waits for
the foreground to return, and captures the post-return snapshot.

Scenarios:
- `photoCapture` — system camera (validates escaped package)
- `pickImage` — system image picker (validates escaped package)
- `pickFile` — system file picker (validates escaped package)
- `custom` — any other cross-app flow (skips validation, requires
  `--description`)

Like `generation manual`, `bridge` goes through risk confirmation. If the
response is `confirmationRequired`, present the challenge and call
`generation confirm` with the user's decision.

A successful bridge step returns `nextBinding` and `nextSnapshotRef` like any
other step. Continue the generation loop from that post-return state.

**Replay note**: In **auto mode** (`replayMode: "auto"`), Core replays the
`externalSteps` deterministically during `finalize` with no operator. In
**manual mode** (`replayMode: "manual"`), a human operator must complete the
external action (take photo, pick image, etc.) before `returnTimeoutMs`
expires, otherwise replay fails with `BRIDGE_NOT_RETURNED`. A non-interactive
finalize (no TTY) rejects manual bridge steps with `MANUAL_STEP_REQUIRED`.

External Flow steps must use `resourceId`-only locators (v1 restricts external
steps to XML-only resource IDs; Compose UI is not supported). List available
flows with `taphound journey list-flows --include-external --json`.

### 3.8 Step 6 — Finalize and Verify

After all steps are complete, start finalize detached:

```bash
taphound generation finalize \
  --project /path/to/android-project \
  --session <generationId> \
  --context .taphound/context/project-context.json \
  --output .taphound/journeys/generated-search.json \
  --device emulator-5554 \
  --detach \
  --json
```

The start result contains `ownerPid`, `outputPath`, and `progressPath`. Wait
without owning the replay process:

```bash
taphound generation status \
  --project /path/to/android-project \
  --session <generationId> \
  --wait \
  --timeout-ms 600000 \
  --json
```

After verification and publication become terminal, parse the detached
finalize JSON at `outputPath`.

**Success**:

```json
{
  "status": "verified",
  "exitCode": 0,
  "generationId": "a1b2c3d4-...",
  "bundlePath": "/path/to/project/.taphound/build/generations/a1b2c3d4-...",
  "journeyPath": "/path/to/project/.taphound/journeys/generated-search.json",
  "metaPath": "/path/to/project/.taphound/journeys/generated-search.meta.json",
  "replayed": true
}
```

Finalize performs:
1. `forceStop` the app
2. Launch and replay all candidate steps in one pass
3. Verify no fallback, no crash, all assertions pass
4. Atomically publish the authoritative bundle to
   `.taphound/build/generations/<id>/`
5. Export Journey v1 and sidecar meta to the `--output` path

**Failure**: troubleshoot by `failure.code`. Common:

| Code | Meaning |
|------|---------|
| `EXPECT_*_FAILED` | Assertion failed during replay |
| `APP_CRASHED` | App crashed during replay |
| `ACTIVITY_*_MISMATCH` | Activity mismatch |
| `EXPORT_FAILED` | Export failed (can retry finalize without replay) |

### 3.9 Verify Artifacts

```bash
# Exported Journey (standard Journey v1, can be replayed with verify)
cat /path/to/project/.taphound/journeys/generated-search.json

# Sidecar meta (verification status, binding hashes, manual override records)
cat /path/to/project/.taphound/journeys/generated-search.meta.json

# Authoritative bundle (full evidence: per-step proposal/snapshot/logcat/result)
ls /path/to/project/.taphound/build/generations/<id>/
```

Authoritative bundle directory structure:

```
.taphound/build/generations/<id>/
├── manifest.json                    # Content file list + hashes
├── meta.json                        # Generation meta (status: verified)
├── candidate/journey.json           # Candidate Journey
├── verified/journey.json            # Verified Journey
├── generation-report.json           # Generation report (per-step provenance)
├── verification/
│   ├── report.json                  # Verify report
│   └── receipt.json                 # Verification receipt
└── evidence/
    ├── observations/<rev>/<attempt>/
    │   ├── snapshot.json
    │   └── screen.png
    ├── confirmations/<challengeId>/
    │   └── envelope.json
    └── steps/<index>-<attemptId>/
        ├── proposal.json
        ├── snapshot.json
        ├── logcat.txt
        └── result.json
```

### 3.10 Re-verify with Standard verify (Optional)

The generated Journey is a standard Journey v1 and can be independently
replayed with the regular verify command:

```bash
taphound verify \
  --project /path/to/android-project \
  --journey .taphound/journeys/generated-search.json \
  --device emulator-5554 \
  --json
```

This proves the AI-generated Journey behaves identically to a manually
recorded Journey.

---

## 4. Complete Example: Testing the Demo Search Feature

Using `examples/taphound-android-demo` as the project, with the Goal
"test the search feature".

### 4.1 Generate Context (One-Time)

```bash
# In the AI agent:
# "Generate a TapHound Project Context for examples/taphound-android-demo"
# AI analyzes source and generates:
# examples/taphound-android-demo/.taphound/context/project-context.json

# Validate
taphound context validate \
  --project examples/taphound-android-demo \
  --context .taphound/context/project-context.json \
  --json
```

### 4.2 Start Session

```bash
taphound generation start \
  --project examples/taphound-android-demo \
  --config .taphound/config.json \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
# Note the generationId
```

### 4.3 Step-by-Step Generation (4 Steps)

| Step | AI decision after observe | Action | Locator | Expect |
|------|---------------------------|--------|---------|--------|
| 1 | Home screen has open_search button | click | resourceId:open_search | element search_input appears |
| 2 | Search screen has search_input field | click | resourceId:search_input | — |
| 3 | Input field is focused | inputText "hello world" | — | — |
| 4 | Search screen has submit_search button | click | resourceId:submit_search | logcat SearchViewModel "submitted query=hello world" |

Each step: observe -> AI generates -> build envelope ->
`generation step --input` -> confirm succeeded.

### 4.4 Finalize

```bash
taphound generation finalize \
  --project examples/taphound-android-demo \
  --session <generationId> \
  --context .taphound/context/project-context.json \
  --output .taphound/journeys/generated-search.json \
  --device emulator-5554 \
  --json
```

Expect `status: "verified"`.

### 4.5 Shortcut

You can also use the automated acceptance script to run steps 4.2-4.4 in
one command (without AI, using hardcoded steps):

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation
```

> This script does not use AI. It validates that the Core protocol itself
> works on-device. For real AI-driven flows, follow steps 4.1-4.4
> manually.

---

## 5. Multi-Scenario Testing

The same Project Context can drive multiple different Goals without
regenerating the Context.

```bash
# Scenario 1: Search feature
# -> generation start -> observe -> step x4 -> finalize
# -> .taphound/journeys/generated-search.json

# Scenario 2: Navigation back test
# -> generation start (new session) -> observe -> step xN -> finalize
# -> .taphound/journeys/generated-back-test.json

# Scenario 3: Input boundary test
# -> generation start (new session) -> observe -> step xN -> finalize
# -> .taphound/journeys/generated-input-edge.json
```

Each Goal is an independent generation session and does not affect others.

---

## 6. Failure Troubleshooting

### 7.1 generation step Failures

| failure.code | Meaning | AI agent response |
|--------------|---------|-------------------|
| `LOCATOR_NOT_FOUND` | Locator not found in current layout | Re-observe, try a different locator |
| `LOCATOR_AMBIGUOUS` | Locator matches multiple elements | Narrow with identity fields or `within`, then use zero-based `index` only if duplicates remain |
| `ACTION_UNSUPPORTED` | Element does not support the action | Check element clickable/scrollable properties |
| `SNAPSHOT_STALE` | Device state has changed | Re-observe |
| `PACKAGE_ESCAPE` | Foreground would switch to another app | Use `generation bridge` with `--flow` (auto) or without (manual) instead of `generation step` |
| `BRIDGE_NO_ESCAPE` | Trigger did not leave the target app within `escapeTimeoutMs` (default 3s) | Check that the trigger actually opens an external app |
| `SCENARIO_PACKAGE_MISMATCH` | Escaped package not in known system list for scenario | Use `--scenario custom` with `--description` |
| `BRIDGE_NOT_RETURNED` | Foreground did not return within `returnTimeoutMs` | Increase timeout or check if external app hung |
| `EXTERNAL_FLOW_NOT_FOUND` | `--flow` names a flow not bound to this session | Re-bind at `generation start --external-flow` or omit `--flow` |
| `EXTERNAL_FLOW_STALE` | Bound flow file changed since `generation start` | Start a new session to rebind the flow |
| `EXTERNAL_PACKAGE_MISMATCH` | External step ran in a different package than `escapedPackageName` | Check the flow's `escapedPackageName` |
| `EXTERNAL_ACTIVITY_MISMATCH` | External step `expectedActivity` did not match | Check the flow's activity expectations |
| `EXTERNAL_STEP_FAILED` | External step action failed (e.g., locator not found) | Check the flow's `resourceId` locators |
| `EXTERNAL_LOCATOR_STRICTNESS` | External step locator lacks `resourceId` | External steps require XML-only `resourceId` locators |
| `ALIGN_CONFIRM_NOT_FOUND` | Camera stayed foreground but no deterministic confirm control was found | Do not generate; inspect the camera review UI or use a supported camera |
| `ALIGN_CONFIRM_NO_RESOURCE_ID` | Camera confirm control has no replayable XML resourceId | Auto replay is unavailable for this camera in External Flow v1 |
| `ALIGN_CONFIRM_AMBIGUOUS` | Multiple confirm controls cannot be selected deterministically | Disambiguate the camera UI before generating |
| `MANUAL_STEP_REQUIRED` | Non-interactive finalize encountered a `replayMode: "manual"` step | Bind an External Flow (`--flow`) or run finalize in a TTY |
| `APP_CRASHED` | App process crashed | Check Logcat, restart app |
| `IDLE_TIMEOUT` | Configured idle strategy did not stabilize | Inspect `failure.details.idle`; use a new session for config changes |
| `RISK_CONFIRMATION_REQUIRED` | Action requires user confirmation or a pending challenge blocks progress | Inspect `generation status`, present the exact challenge, and apply only the user's explicit decision |
| `ACTION_FORBIDDEN` | Action is forbidden by policy | Use a different action or adjust policy |
| `RECOVERY_REQUIRED` | Session entered recovery state | Inspect status and ask before explicit retry |
| `APP_LAUNCH_FAILED` | No-Base-Flow startup could not reach the configured app process and Activity | Check installation, launch Activity, and device state, then start a new session |

### 7.2 generation finalize Failures

| failure.code | Meaning | Action |
|--------------|---------|--------|
| `EXPECT_*_FAILED` | Assertion failed during replay | Check verification/report.json |
| `APP_CRASHED` | App crashed during replay | Check app stability |
| `ACTIVITY_*_MISMATCH` | Activity mismatch | Check step's activity.before |
| `EXPORT_FAILED` | Export failed | Can retry finalize directly (no re-replay) |

### 7.3 View Session State

```bash
taphound generation status \
  --project /path/to/android-project \
  --session <generationId> \
  --json
```

If status reports recovery is available, the previous action or verification
replay may already have produced external side effects. Show
`actionMayHaveExecuted` and the immutable `attemptOutcome` to the user. Only
after the user explicitly chooses retry:

```bash
taphound generation recover \
  --project /path/to/android-project \
  --session <generationId> \
  --decision retry \
  --json
```

`recover` only clears the recovery lock after explicit acknowledgement. It
does not commit the previous action, capture a post-action snapshot, or return
`nextBinding`/`nextSnapshotRef`. Run `generation observe` afterward. If the
action already took effect, stop rather than continuing with a candidate that
omits it or automatically repeating it.

The config, including `idle.strategy`, is bound when the session starts.
Changing it requires a new session. For continuously rendering screens use
`layoutDiff`, or retain the default `hybrid`, which falls back from frame
activity to Core-owned structural layout hashing.

---

## 7. Safety Constraints

- The AI agent does NOT auto-approve `confirmationRequired` steps; human
  approval of the exact challenge is mandatory. `--decision approve` only
  relays that explicit decision from a non-TTY environment.
- The AI agent does NOT bypass Core safety boundaries (package guard, risk
  policy, locator uniqueness).
- SHA-256 hashes are ALWAYS computed via shell; the AI never guesses hash
  values.
- The generated Journey is a standard Journey v1 and can be independently
  replayed with the regular `verify` command.
- Real-device acceptance is fully separate from the normal test suite and
  does NOT run in `npm test`.
