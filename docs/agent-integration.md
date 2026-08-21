# Calling TapHound from an Agent CLI

TapHound provides two integration surfaces for Agents:

- Use `taphound verify --json` to deterministically verify an existing Journey.
- Use a Project Context and `taphound generation ... --json` to generate a new Journey, which TapHound then fully Replays from the initial state and publishes after verification.

An external Agent may analyze source code, judge whether a goal is complete, and propose the next step, but TapHound Core never invokes a model. Project Context validation, device-state binding, proposal validation, risk confirmation, ADB execution, final Replay, and assertions are all handled by deterministic code.

## Verifying an Existing Journey

A typical flow: a developer uses Claude Code or another Agent CLI to implement a requirement, then has the Agent call TapHound Journey to verify whether the code meets expectations.

```bash
taphound verify \
  --project /workspace/android-app \
  --config /workspace/android-app/taphound.config.json \
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
   selects the deepest applicable valid Flow, never by filename alone.
5. `generation start --module ... [--base-flow ...]` binds the project,
   config, selected module dependency closure, device, and optional cleanly
   replayed Flow prefix. Without a Base Flow, Core force-stops and launches the
   configured Activity before creating the session.
6. The Agent uses `generation observe --compact --json`, reads the project-
   relative authoritative `snapshotRef`, and submits a proposal strictly bound
   to that full snapshot. Compact successful steps return `nextBinding` and
   `nextSnapshotRef`; the Agent reads the reference before the next proposal.
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

`taphound init` copies the TapHound AI Journey Skill from the npm package into each Agent's Skill directory. The interactive multi-select requires choosing at least one Agent; you can also specify non-interactively with `--agent`:

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

The Skill ships with the npm package (`assets/skills/`), and `taphound init` copies it from the package into the target directory. Re-running `init` overwrites existing Skill files.

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
