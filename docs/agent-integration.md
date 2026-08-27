# Calling TapHound from an Agent CLI

TapHound provides two integration surfaces for Agents:

- Use `taphound verify --json` to deterministically verify an existing Journey.
- Use a Project Context and `taphound generation ... --json` to generate a new Journey, which TapHound then fully Replays from the initial state and publishes after verification.

An external Agent may analyze source code, judge whether a goal is complete, and propose the next step, but TapHound Core never invokes a model. Project Context validation, device-state binding, proposal validation, risk confirmation, ADB execution, final Replay, and assertions are all handled by deterministic code.

TapHound intentionally stops at the Journey boundary. External Workflow Skills
own requirement analysis, planning, coding, build/install, multi-Case
orchestration, completion gates, and diagnosis. An orchestrator can invoke
TapHound once per independent Case and adapt the public JSON, Report, and
evidence paths into its own Task/Result protocol. Workflow correlation and
Requirement/Plan identities remain outside TapHound.

For one Case, an external orchestrator may supply the optional Skill-level
`journeyBrief` binding:

```json
{
  "path": ".android-agent-workflow/req-search-001/cases/CASE-002/taphound-journey-brief.md",
  "sha256": "<SHA-256 of the exact file bytes>"
}
```

The Markdown format is defined by
[`taphound-journey-brief.example.md`](../assets/skills/taphound-ai-journey/templates/taphound-journey-brief.example.md).
This is not a Core CLI argument. It provides static Case hints to the Journey
Skill; Project Context, live Snapshot binding, risk policy, and final Replay
remain authoritative.

## Journey Brief Authoring

The [`taphound-journey-brief-author` Skill](../assets/skills/taphound-journey-brief-author/SKILL.md)
is the recommended producer of the Brief. It combines Android source analysis
with read-only `taphound observe` to author one Brief v2 per Case, then
returns `{path, sha256}` for the Journey Skill to consume. It uses only
read-only commands and never modifies device state.

### Subagent dispatch pattern

A multi-Case orchestrator dispatches one brief-author subagent per Case.
Configure the subagent with a **name** and a **PROMPT** field whose content
is copied verbatim from
[`brief-author-role.md`](../assets/skills/taphound-journey-brief-author/prompts/brief-author-role.md).
That file is self-contained: it defines the role, capability boundary, inputs,
execution procedure, output format, and rules. The orchestrator then
dispatches a dynamic task message per Case with these explicit inputs:

| Field | Required | Description |
|---|---|---|
| `project` | yes | Android project root path |
| `caseGoal` | yes | One Case's test scenario (natural language) |
| `caseId` | no | Case identifier for frontmatter |
| `contextPaths` | no | Explicit path array; the subagent reads ONLY these files for surrounding context |
| `observeSnapshot` | no | Pre-captured `taphound observe --json` result |
| `output` | no | Brief output path (defaults to `.taphound/journeys/taphound-journey-brief.md`) |

The subagent returns a single JSON summary:

```json
{
  "status": "authored",
  "caseId": "CASE-002",
  "path": ".taphound/journeys/taphound-journey-brief.md",
  "sha256": "<64-char hex hash>",
  "edgesVerified": 2,
  "edgesNeedsObservation": 1
}
```

The orchestrator never re-parses raw exploration content from the subagent;
it consumes only this structured summary.

### Hard rule on file names

The brief-author subagent MUST NEVER search for or assume files named
`plan.md`, `requirement.md`, or any convention. It reads ONLY files the
orchestrator explicitly passes via `contextPaths`. If no `contextPaths` are
supplied, it works from `caseGoal` alone plus source code and Project Context.
This rule is encoded in both `SKILL.md` and `brief-author-role.md`.

### Parallel strategy and device contention

To enable parallel brief authoring across multiple Cases without device
contention, the orchestrator pre-captures one `taphound observe --json`
snapshot and passes it to all parallel brief-author subagents via the
`observeSnapshot` input. When `observeSnapshot` is provided, the subagent
uses it directly and MUST NOT call `taphound observe` itself.

```bash
# Orchestrator captures once, before dispatching parallel subagents:
taphound observe --project <project> --device <serial> --logcat-lines 200 --json
# Then passes the result as observeSnapshot to each parallel subagent.
```

### Human Review gate

The Brief is an inspectable artifact between the planning phase and Journey
generation. After a brief-author subagent returns `status: "authored"`, the
orchestrator should present the Brief path and summary to the user for
Review before dispatching the downstream Journey generation subagent with
the `journeyBrief: {path, sha256}` binding. Review is a Skill convention,
not a Core CLI gate; the Journey Skill's own Brief validation (SHA-256
check, frontmatter, required sections, Goal match) remains enforced.

```
Orchestrator
  |-- dispatch brief-author subagent  (per Case, parallel)
  |     output: {path, sha256, caseId, edgesVerified, edgesNeedsObservation}
  |
  |-- human Review (brief is an inspectable artifact)
  |
  |-- dispatch journey subagent
        input:  {project, goal, journeyBrief: {path, sha256}}
        output: {journeyPath, reportPath, verified}
```

## Verifying an Existing Journey

A typical flow: a developer uses Claude Code or another Agent CLI to implement a requirement, then has the Agent call TapHound Journey to verify whether the code meets expectations.

```bash
taphound verify \
  --project /workspace/android-app \
  --config /workspace/android-app/.taphound/config.json \
  --journey /workspace/android-app/.taphound/journeys/search.json \
  --device emulator-5554 \
  --json
```

## Machine Contract

- The stdout of `verify --json` contains exactly one JSON value and a trailing newline, with no progress text.
- stderr receives pre-checks, progress, and diagnostics, which the Agent may save separately.
- The process exit code matches the JSON `exitCode`.
- `0` means passed; `1` is a product verification failure; `2` is invalid input; `3` is an unavailable environment; `4` is a TapHound internal error.
- When a report exists, read `reportPath`, `report.primaryFailure`, `report.secondaryErrors`, and the layered results.
- When no report exists, read the top-level `failure.code` and `failure.message`.

Do not merely search stdout text for "passed"; first check the process status and `exitCode`, then read the structured fields.

## Node.js Invocation Example

```js
import { spawn } from "node:child_process";

const child = spawn("taphound", [
  "verify",
  "--project", projectRoot,
  "--journey", journeyPath,
  "--json"
], { shell: false });

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });

child.on("close", code => {
  const result = JSON.parse(stdout);
  if (code !== result.exitCode) throw new Error("TapHound exit contract mismatch");
  // Feed result.report.primaryFailure back to the development Agent.
});
```

The caller must also use an argument array and keep `shell: false`, to avoid turning project paths or user input into a Shell command.

## Generating a New Journey

The generation flow uses the in-repo [`taphound-ai-journey` Skill](../assets/skills/taphound-ai-journey/SKILL.md):

1. `project describe --json` outputs stable Package and Activity information.
2. The Agent analyzes each Gradle module independently and produces a Project Context v2 root index plus module shards.
3. `context list` exposes the compact module catalog. `context validate` / `context status` check the index, shard hashes, source evidence, and per-module file inventory. `context refresh` recomputes evidence hashes for an existing Context without re-analyzing source.
4. `journey list-flows --json` validates reusable local prefixes. The Agent
   selects the deepest applicable valid Flow, never by filename alone. The
   first resolved step must begin at a stable Activity deterministically
   reached after cold launch. A transient Splash must not be required to
   remain foreground; `core/launch-home` should be a `wait: Home -> Home`
   readiness anchor with an expectation for a unique Home element.
5. `generation start --module ... [--base-flow ...]` binds the project,
   config, selected module dependency closure, device, and optional cleanly
   replayed Flow prefix. Without a Base Flow, Core force-stops, launches the
   configured Activity, and waits for the App process before creating the
   session. `run.activity` is only the cold-launch entry; the subsequent
   observation's idle/layout checks establish the stable post-redirect state.
6. The Agent uses `generation observe --compact --json`, reads the project-
   relative authoritative `snapshotRef`, and submits a proposal strictly bound
   to that full snapshot. Compact successful steps return `nextBinding` and
   `nextSnapshotRef`; the Agent reads the reference before the next proposal.
   Active references point into the Store-owned
   `.<generationId>.work` bundle; publication atomically moves the same
   evidence into the final `<generationId>` bundle.
   It uses `generation confirm` when human approval is required, and
   `generation manual` for local TTY overrides. Confirmation defaults to a
   local prompt. In a non-TTY sandbox, the Agent may pass
   `--decision approve|decline` only after the user explicitly reviews that
   exact challenge; the decision remains bound to Core-owned evidence.
7. `generation status` exposes durable state. Interrupted work is retried only
   after explicit `generation recover --decision retry` acknowledgement.
8. `generation finalize --detach` survives caller interruption and fully
   Replays from the initial state. The Journey and immutable evidence are
   published only after exact verification passes.
9. `generation list --json` enumerates all sessions in the workspace (active,
   archived, and published). `generation archive --session <id>` marks an idle
   active session as archived so it no longer clutters active listings. Archive
   is only permitted on sessions with no in-flight step or pending
   confirmation; recoveryRequired sessions must be recovered first.

```bash
taphound project describe --project /workspace/android-app --json
taphound context validate \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --json
taphound journey list-flows \
  --project /workspace/android-app \
  --json
taphound generation start \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --module :feature:search \
  --base-flow search/open \
  --device emulator-5554 \
  --json
```

The application module is always selected; dependencies declared by selected modules are expanded automatically. Omitting `--module` selects all modules. The exact root-index hash and selected shard IDs/hashes are returned as `contextSelection` and bound to the session. Modules cannot be added later. The device is bound at `generation start`. `generation observe`, `step`, `confirm`, `manual`, `status`, and `recover` use that binding via `--session` and do not accept `--device`; `generation finalize` reloads exactly the bound module set and may explicitly provide `--device`, but must not change the session identity binding.

### Refreshing Context Evidence Hashes

`context refresh` recomputes evidence hashes for an existing Context without re-analyzing source. It backfills the optional `semanticSha256` for every evidence file, rehashes files whose change was formatting or comments only, repairs index entries whose shard hash drifted, and rewrites only the shards and index that actually changed.

```bash
taphound context refresh \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --json
```

Refresh never invents semantic knowledge. It stops with `exitCode: 1` and `status: "blocked"` when evidence changed semantically, when a module's file inventory changed, or when an evidence file is missing or unreadable, because those cases need module re-analysis. `--module <id...>` limits refresh to selected modules. `--accept-source-changes` additionally rehashes semantically changed evidence and inventory drift; use it only when the recorded module summary is still accurate, since the summary itself is not updated. Missing or unreadable evidence always blocks.

By default, changed source evidence stops generation with `CONTEXT_STALE`. For frequent implementation-only edits, an agent may explicitly pass `--allow-evidence-drift` to both `generation start` and `generation finalize`. This does not bypass Context shard integrity, project/config/session bindings, locator safety, or final replay verification. It only allows the validator's evidence-file drift result to proceed; the final replay remains authoritative. JSON output reports `evidenceDriftAllowed: true` when this opt-in is active.

Generation's `--json` commands likewise write only one machine-readable JSON
value to stdout and indicate the result with `exitCode`. `observe` always
returns `snapshotRef`; `--compact` omits the duplicate inline snapshot.
`step`, `confirm`, and `manual` similarly replace `nextSnapshot` with
`nextSnapshotRef` in compact mode. The referenced file is still the full
RuntimeSnapshot required by the proposal envelope. The Agent must retain
`generationId`, `baseRevision`, `snapshotHash`, and that exact snapshot, and
must not fabricate or reuse expired bindings. Step results include phase timing
for freshness, evidence setup, observation, action, idle wait, expectations,
Logcat, and optional next observation. Detached finalize progress and stdout
live under `.taphound/build/jobs/<generationId>/`, outside the authoritative
bundle. For the full protocol, retry rules, and Context update strategy, see
the Skill's [`GUIDE.md`](../assets/skills/taphound-ai-journey/GUIDE.md).

The `generation step --input` envelope is a strict object with exactly three
top-level fields. Unknown, missing, or flat (unwrapped) fields are rejected as
`CONTEXT_INVALID`; the JSON failure includes a `hint` describing the required
shape:

```jsonc
{
  "version": 1,
  "proposal": {
    "action": "click",
    "locator": { "resourceId": "btn_more" },
    "binding": {
      "generationId": "<session-id>",
      "baseRevision": 2,
      "snapshotHash": "<sha256-of-snapshot>"
    },
    "activity": { "before": "com.example.app.AIChatActivity" }
  },
  "snapshot": { /* full RuntimeSnapshot returned by generation observe */ }
}
```

`proposal.binding` must match the `nextBinding`/`binding` returned by the most
recent `observe` (or prior step), and `snapshot` must be that exact
RuntimeSnapshot. `activity.after` and `expect` are optional on a proposal;
Core records the observed post-action Activity and evaluates any supplied
expectation.


When Base Flow verification fails, `generation start --json` returns
`FLOW_REPLAY_FAILED` details containing the Flow name, Verify report path,
primary failure, the failed step's Activity/locator/expectation summary, and
recovery guidance. The Agent must not silently skip reuse or treat a device
already showing Home as an exact replay. It should repair or re-record the
Flow, and restart without `--base-flow` only after the user explicitly chooses
that bypass.
When an indexed Locator is resolvable from the bound snapshot, Core persists
versioned, non-geometric semantic evidence for the selected element. Replay
recomputes that evidence before mutation and fails instead of using annotated
fallback when the indexed element's represented content changed. Existing
Journeys without this optional evidence retain their previous ordinal
behavior.

`generation status` includes `pendingConfirmation` and its computed `expired`
flag. While a challenge is pending, `observe` returns
`RISK_CONFIRMATION_REQUIRED` with challenge details rather than an internal
error. An expired challenge cannot be approved; resolve it with the exact
challenge ID (for example `confirm --decision decline`) before observing and
submitting a fresh proposal.
For approved actions, the challenge ID and `approvalMode` (`localTty` or
`delegated`) are stored in the in-flight attempt before device mutation and in
the immutable step result, so interrupted-action recovery retains the approval
audit.

## Installing the Skill for AI Agents

`taphound init` copies the TapHound AI Journey Skill from the npm package into
each Agent's Skill directory. The interactive multi-select requires choosing
at least one Agent; you can also specify non-interactively with `--agent`:

```bash
taphound init --agent claude,codex,cursor,droid --json
```

Global install (user-level directory):

```bash
taphound init --agent claude --global
```

Supported Agents and paths:

| Agent | Project-level path | User-level path |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| Droid | `.factory/skills/` | `~/.factory/skills/` |
| Other | `.agents/skills/` | `~/.agents/skills/` |

The Skill ships with the npm package (`assets/skills/`), and `taphound init`
copies it into the target Skill root. Re-running `init` overwrites existing
files in the installed Skill directory.

## Minimal Instructions for Claude Code

```text
After implementation is complete, run:
taphound verify --project . --journey .taphound/journeys/search.json --json
Parse the JSON; acceptance passes only when exitCode=0.
If it fails, report report.primaryFailure first, and include reportPath.
Do not modify the Journey to mask implementation defects.
```

## Safety and Determinism

TapHound Replay never invokes AI. The Agent may select an existing Journey or propose new steps in a generation session, but the final judgment of Locator, Activity, Layout Diff, risk policy, and Expect is performed by deterministic code. The Agent must not automatically loosen assertions, swap the Package, delete steps, or bypass confirmation after a failure.

Generation binds the normalized config for the lifetime of the session. Agents
must choose `idle.strategy` before `generation start` and must start a new
session after any config change. `hybrid` falls back from active frame counters
to Core-owned UIAutomator layout hashes; `layoutDiff` selects structural
stability directly. An action attempt that returns
`status: "recoveryRequired"` may already have executed. Inspect
`generation status`, obtain explicit user approval before `recover`, and never
assume that recovery committed the interrupted action or returned a snapshot.

## Cross-Application Flows

TapHound Core enforces single-package determinism. When a step causes the
foreground to leave the configured target package — for example tapping a
button that opens the system camera, a file picker, or a third-party share
sheet — `generation step` and `generation manual` reject the post-action
snapshot with `PACKAGE_ESCAPE`. This is by design: TapHound cannot
deterministically bind or replay actions that execute in a process it does not
own.

### Bridge Action

The `bridge` action lets Core own the trigger click and the return detection
for cross-app flows within a single generation step. Core clicks the trigger,
detects the package escape, optionally executes a bound External Flow's steps
inside the escaped package, waits for the foreground to return, and captures
the post-return snapshot.

Bridge steps run in two replay modes:

- **Auto** (`replayMode: "auto"`): `--flow <name>` resolves a bound External
  Flow. Core stamps the flow's steps as `externalSteps` and replays them
  deterministically during `finalize` with no human operator.
- **Manual** (`replayMode: "manual"`): no `--flow`. A human operator completes
  the external action during replay.

Bind External Flows at session start:

```bash
taphound generation start \
  --project . \
  --external-flow camera/photo-capture \
  ...
```

List available flows (built-in and project):

```bash
taphound journey list-flows --project . --include-external --json
```

Use `generation bridge` with one of the built-in scenarios:

- `photoCapture` — system camera (validates escaped package)
- `pickImage` — system image picker (validates escaped package)
- `pickFile` — system file picker (validates escaped package)
- `custom` — any other cross-app flow (skips package validation, requires
  `--description`)

```bash
# Auto bridge (deterministic, no operator)
taphound generation bridge \
  --project . \
  --session <id> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"com.example.app:id/camera_button"}' \
  --flow camera/photo-capture \
  --return-timeout-ms 60000 \
  --escape-timeout-ms 3000 \
  --json

# Manual bridge (human operator completes external action)
taphound generation bridge \
  --project . \
  --session <id> \
  --scenario photoCapture \
  --trigger-locator '{"resourceId":"com.example.app:id/camera_button"}' \
  --return-timeout-ms 60000 \
  --json
```

Like `generation manual`, `bridge` goes through risk confirmation. If the
action is not auto-approved, the response carries `status:
"confirmationRequired"` and the Agent calls `generation confirm` with the human
decision.

### Failure Codes

- `BRIDGE_NO_ESCAPE` — the foreground did not leave the target package within
  `escapeTimeoutMs` (default 3 seconds) of the trigger click.
- `SCENARIO_PACKAGE_MISMATCH` — the escaped package is not in the known system
  package list for the selected scenario. Use `custom` to bypass.
- `BRIDGE_NOT_RETURNED` — the foreground did not return to the target package
  within `returnTimeoutMs`.
- `EXTERNAL_FLOW_NOT_FOUND` — `--flow` names a flow not bound to this session.
- `EXTERNAL_FLOW_STALE` — the bound flow file changed since `generation start`.
- `EXTERNAL_PACKAGE_MISMATCH` — an external step ran in a different package
  than `escapedPackageName`.
- `EXTERNAL_ACTIVITY_MISMATCH` — an external step's `expectedActivity` did not
  match.
- `EXTERNAL_STEP_FAILED` — an external step's action failed (e.g., locator not
  found).
- `EXTERNAL_LOCATOR_STRICTNESS` — an external step locator lacks a `resourceId`
  (v1 requires XML-only resource IDs for external steps).
- `MANUAL_STEP_REQUIRED` — a non-interactive `finalize` encountered a
  `replayMode: "manual"` step. Bind an External Flow or run finalize in a TTY.

See [`docs/journey-schema.md`](./journey-schema.md) for the full bridge schema
and [`examples/bridge-camera.journey.json`](../examples/bridge-camera.journey.json)
for a complete Journey.
