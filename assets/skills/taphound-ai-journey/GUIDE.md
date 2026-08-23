# TapHound AI Journey Usage Guide

This guide describes how to use an AI agent (Droid, Claude Code, Cursor,
etc.) to drive TapHound's generation protocol for end-to-end testing on
a real Android device.

## Architecture Overview

```
User provides Goal (natural-language test scenario)
        |
        v
+-----------------------------+
|  One-time setup (first run   |
|  or after major changes)     |
|  AI analyzes source ->       |
|  Project Context             |
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

Project Context is generated once and reused. It only needs regeneration
when the project source changes significantly (see Section 5).

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

## 2. One-Time Setup: Generate Project Context

> Project Context describes the Android project's UI structure, element
> locators, and interaction policy. It is generated once, persisted in the
> project directory, and reused for every test run. Only significant source
> changes require regeneration (see Section 5).

### 2.1 Load the Skill in Your AI Agent

Run `taphound init` to install the Skill into each agent's expected directory,
then load it in your AI agent tool. The entry file is `SKILL.md`. The method
depends on the tool:

- **Droid**: The Skill is auto-discovered from `.factory/skills/` in the
  TapHound repo. Run `taphound init --agent droid` in other projects.
  Invoke it with the Skill tool using `taphound-ai-journey`.
- **Claude Code**: Run `taphound init --agent claude` to install to
  `.claude/skills/`, then invoke with the Skill tool.
- **Codex**: Run `taphound init --agent codex` to install to `.agents/skills/`.
- **Cursor**: Run `taphound init --agent cursor` to install to `.cursor/skills/`.
- **Other tools**: Run `taphound init --agent other` to install to
  `.agents/skills/`, or have the agent read `SKILL.md` directly.

### 2.2 Have the AI Analyze Project Source

Tell the AI agent (after the Skill is loaded, just provide the project
path):

```
Generate a TapHound Project Context for the project at /path/to/android-project.
```

The AI agent will follow SKILL.md Phase 1 instructions and automatically
perform these steps:

1. Run `./gradlew projects` to discover all modules (falls back to parsing
   `settings.gradle` if no wrapper), and identify the app module (the one
   with `applicationId`).
2. Read `applicationId` from the app module's `build.gradle` or
   `build.gradle.kts` as the package name (falls back to the `package`
   attribute in the manifest for legacy projects).
3. Identify the launch Activity from the app module's `AndroidManifest.xml`
   (library module Activities are merged in via manifest merge).
4. Analyze each module independently for Activities, click handlers, Logcat
   tags, navigation, and layouts. Write one v2 shard under
   `.taphound/context/modules/` before moving to the next module.
5. Store reusable screen, element, transition, and Logcat semantics in each
   shard. Compute evidence hashes and the module inventory path-set hash.
6. Mark every discovered module `complete`, `partial`, `unsupported`, or
   `notAnalyzed`; never silently omit a module because the project is large.
7. Hash each completed shard and write the compact v2 root index matching
   `schemas/project-context.json`.

> **Multi-module note**: Activities may be distributed across library/feature
> modules, and layout XML may be in any module's `res/layout/`. The AI agent
> uses `./gradlew projects` to get the authoritative module list. The root
> index stays small; detailed semantics are loaded from selected shards.

### 2.3 Write and Validate Context

The AI-generated Bundle is written to:

```
<project>/.taphound/context/
├── project-context.json
└── modules/
    ├── app.json
    └── feature-search.json
```

Then validate:

```bash
taphound context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

**Success**: `"status": "valid"`, exit 0. Context is ready, proceed to
Section 3.

**Failure**: Fix based on the error message. Common causes:

| Error | Cause | Fix |
|-------|-------|-----|
| `CONTEXT_INVALID` | Package name / Activity mismatch | Check against AndroidManifest.xml |
| `CONTEXT_INVALID` | Incorrect SHA-256 | Recompute hash using shell |
| `CONTEXT_INVALID` | Path contains `..` or starts with `/` | Use project-relative paths |
| `CONTEXT_STALE` | File content does not match hash | Source changed, recompute hashes |

### 2.4 Check Context Status (Optional)

You can check whether the Context is still valid at any time:

```bash
taphound context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

Returns `"valid"` (still valid), `"stale"` (files changed, needs update),
or `"invalid"` (structural error).

List the compact module catalog without loading all shards:

```bash
taphound context list \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --json
```

### 2.5 Context Persistence

The generated `project-context.json` is saved in the project's
`.taphound/context/` directory. This file can be:

- **Committed to Git**: If the project source is stable, the Context can
  be tracked as a project artifact.
- **Added to .gitignore**: If the project changes frequently, regenerate
  dynamically before each run.

Recommendation: commit to Git after first generation, update per Section 5
when source changes.

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
  --config taphound.config.json \
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
| 1 | `CONTEXT_STALE` | Source changed, update Context per Section 5 |
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
`snapshotHash`, plus `snapshotRef`. Read that project-relative authoritative
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
leaves the target package. Use `generation bridge` instead:

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

Core clicks the trigger, detects the package escape, waits for the foreground
to return, and captures the post-return snapshot. The committed step carries
`replayMode: "manual"`.

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

**Replay note**: During `finalize`, a human operator must complete the
external action (take photo, pick image, etc.) before `returnTimeoutMs`
expires, otherwise replay fails with `BRIDGE_NOT_RETURNED`.

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
  --config taphound.config.json \
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

## 5. Updating Project Context

Android projects evolve continuously: buttons are added, layouts are
restructured, Activities come and go. The Context needs to track these
changes to remain useful for staleness detection and interaction policy.

There are three levels of update, from lightest to heaviest:

### 5.1 Pre-Session Check (Before Every Test Run)

Run this before each generation session to decide which update level is
needed.

**Step 1: Hash staleness check**

```bash
taphound context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

- `"valid"`: All tracked file hashes match. Proceed to Step 2.
- `"stale"`: Some tracked files changed. Needs at least an incremental
  update (Section 5.2).
- `"invalid"`: Context structure is broken. Needs full regeneration
  (Section 5.3).

**Step 2: Module completeness check**

Module inventory path-set hashes include manifest, source, layout, and
navigation paths. `context status` therefore detects files added or removed
inside an existing module. Root project evidence detects changes to the
Gradle module catalog. Also run `context list --json` and ensure every module
is explicitly `complete`; `partial`, `unsupported`, and `notAnalyzed` are
coverage gaps, not successful full generation.

**Decision matrix:**

| `context status` | Module catalog | Action |
|------------------|----------------|--------|
| `valid` | All selected modules complete | Proceed to test |
| `valid` | Any module incomplete | Complete that module shard |
| `stale` | Existing module changed | Run `context refresh --json`, then act on each block's `resolution` (see 5.2) |
| `stale` | Module catalog changed | Update index and generate new shards |
| `invalid` | — | Repair or regenerate Bundle |

### 5.2 Incremental Update (Content-Only Changes)

**Step 0: Hash-only refresh**

Before any re-analysis, let TapHound recompute hashes:

```bash
taphound context refresh \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

- `"refreshed"` / `"unchanged"`: nothing semantic changed. `semanticSha256`
  values are backfilled, formatting- or comment-only edits are rehashed,
  drifted shard hashes in the index are repaired, and the Context is current.
- `"blocked"`: the response lists the modules and files that changed
  semantically, whose inventory changed, or whose evidence is missing. Each
  block carries a `resolution` field — act on it, do not blanket re-analyze:

  | block `code` | `resolution` | Action |
  |---|---|---|
  | `EVIDENCE_UNRESOLVED` | `pruneDeleted` | A tracked file was deleted. Re-run with `--prune-deleted` (drops the entry). Combine with `--accept-source-changes` if inventory also drifted. |
  | `EVIDENCE_SEMANTIC_CHANGED` | `acceptSourceChanges` | A tracked file's semantics changed. Re-run with `--accept-source-changes` to rehash. Re-analyze (below) only if the module summary is now wrong. |
  | `MODULE_INVENTORY_CHANGED` | `acceptSourceChanges` | The on-disk file set grew or shrank. Re-run with `--accept-source-changes` to accept the new inventory hash. Re-analyze only when new UI files were added that the summary must cover. |
  | `EVIDENCE_UNRESOLVED` | `reanalyze` | An evidence file is unreadable/escaped/too large (not a clean deletion). Fix the file or regenerate that module's shard (below). |

The typical one-shot reconcile for routine edits + deletions:

```bash
taphound context refresh \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --prune-deleted --accept-source-changes --json
```

`--module <id...>` narrows the scope. `--accept-source-changes` rehashes
semantic and inventory drift; use it only after confirming the recorded module
summary (screens, elements, transitions, Logcat) is still accurate, because
`refresh` never updates semantics. `--prune-deleted` only drops entries for
files that are truly gone (`notFound`); unreadable or escaped files stay
blocked as `reanalyze`.

When a block's `resolution` is `reanalyze`, or when `acceptSourceChanges`
would hide newly added UI screens the Goal may reach, regenerate the affected
module shards instead of reanalyzing unrelated features:

1. Identify which files changed (the `context status` output lists them).
2. Recompute SHA-256 for each changed file.
3. If any changed file is an Activity source, re-read it to check for:
   - New Logcat tags (affects `expect` candidates)
   - New click handlers or input fields (affects `interactionPolicy`)
   - New `startActivity` calls (affects navigation understanding)
4. If any changed file is a layout XML, re-read it to check for:
   - New `android:id` elements (new locator candidates)
   - Removed elements (locators that no longer exist)
   - Changed `android:text` or `android:contentDescription`
5. Update shard semantics, evidence, and inventory. Write the shard,
   recompute its file hash, and update the root index reference.
6. Update the global `interactionPolicy` only when needed, then validate:
   ```bash
   taphound context validate \
     --project /path/to/android-project \
     --context /path/to/android-project/.taphound/context/project-context.json \
     --json
   ```

This is fast because it only touches changed files, not the entire
project.

### 5.3 Full Regeneration (Structural Changes)

When a new Gradle module is added or the Bundle is `invalid`, update the
module catalog and generate only missing or invalid shards:

1. Have the AI agent re-analyze the source (reads `prompts/analyze-project.md`)
2. Re-discover all modules via `./gradlew projects` or filesystem fallback
3. Add every discovered module to the root index with explicit status
4. Generate each new/invalid module shard independently
5. Recompute affected shard hashes and global interaction policy
6. Rewrite the root index
7. Validate with `context validate`

```bash
# In the AI agent:
# "Regenerate the TapHound Project Context for /path/to/android-project.
#  The source has been updated with new screens and layouts.
#  Run a full re-analysis per prompts/analyze-project.md."

taphound context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

### 5.4 Signs of Stale Context During Generation

Sometimes the pre-session check passes but the Context is still outdated
(e.g., a layout's content changed without changing the file count). The
AI agent may encounter these signs during generation:

| Sign | Likely cause | Action |
|------|-------------|--------|
| `observe` shows elements not expected from Context | Layout changed (new elements) | Continue if the element is actionable; update Context after session |
| `observe` shows a different Activity than expected | New Activity added or navigation changed | Re-observe and adapt; update Context after session |
| `LOCATOR_NOT_FOUND` for an element that should exist | Element was removed or `android:id` changed | Re-observe, try alternative locator; update Context after session |
| `LOCATOR_AMBIGUOUS` for a previously unique element | Duplicate ID added in another layout | Use more specific locator; update Context after session |
| Logcat expectation fails | Log tag or message pattern changed | Check source, update expectation; update Context after session |

> When any of these signs appear, the AI agent should note the discrepancy
> and recommend a Context update after the session completes. It should
> NOT abort the session unless the error is unrecoverable.

### 5.5 When to Update

| Change type | Update level |
|-------------|-------------|
| Modified button text or content description | Incremental (re-hash) |
| Modified click handler logic | Incremental (re-hash, check Logcat tags) |
| Added/removed `android:id` in existing layout | Incremental (re-hash) |
| Added new Activity | Full regeneration |
| Removed Activity | Full regeneration |
| Added/removed layout XML file | Full regeneration |
| New module added (`settings.gradle` changed) | Full regeneration |
| Changed `applicationId` | Full regeneration |
| Modified `<include>`/`<merge>` structure | Incremental (re-hash) |
| Modified business logic but UI unchanged | Incremental (re-hash only) |
| Modified themes/styles | No update needed |
| Modified Gradle dependency versions | No update needed (unless package name changed) |

---

## 6. Multi-Scenario Testing

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

## 7. Failure Troubleshooting

### 7.1 generation step Failures

| failure.code | Meaning | AI agent response |
|--------------|---------|-------------------|
| `LOCATOR_NOT_FOUND` | Locator not found in current layout | Re-observe, try a different locator |
| `LOCATOR_AMBIGUOUS` | Locator matches multiple elements | Narrow with identity fields or `within`, then use zero-based `index` only if duplicates remain |
| `ACTION_UNSUPPORTED` | Element does not support the action | Check element clickable/scrollable properties |
| `SNAPSHOT_STALE` | Device state has changed | Re-observe |
| `PACKAGE_ESCAPE` | Foreground would switch to another app | Use `generation bridge` with the appropriate scenario instead of `generation step` |
| `BRIDGE_NO_ESCAPE` | Trigger did not leave the target app within 3s | Check that the trigger actually opens an external app |
| `SCENARIO_PACKAGE_MISMATCH` | Escaped package not in known system list for scenario | Use `--scenario custom` with `--description` |
| `BRIDGE_NOT_RETURNED` | Foreground did not return within `returnTimeoutMs` | Increase timeout or check if external app hung |
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

## 8. Safety Constraints

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
