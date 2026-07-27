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
  --journey /workspace/android-app/journeys/search.json \
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
2. The Agent analyzes the Android project source and produces a Project Context with file-hash evidence.
3. `context validate` / `context status` check the Context's structure, identity, and timeliness.
4. `generation start` binds the project, config, Context, and device.
5. The Agent loops: call `generation observe` to obtain an authoritative snapshot, then submit a proposal strictly bound to that snapshot via `generation step`; use `generation confirm` when human approval is required, and `generation manual` for local TTY overrides.
6. `generation finalize` fully Replays from the initial state; the Journey and immutable evidence are published only after exact verification passes.

```bash
taphound project describe --project /workspace/android-app --json
taphound context validate \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --json
taphound generation start \
  --project /workspace/android-app \
  --context .taphound/context/project-context.json \
  --device emulator-5554 \
  --json
```

The device is bound at `generation start`. `generation observe`, `step`, `confirm`, and `manual` use that binding via `--session` and do not accept `--device`; `generation finalize` may explicitly provide `--device`, but must not change the session identity binding.

Generation's `--json` commands likewise write only one machine-readable JSON value to stdout and indicate the result with `exitCode`. The Agent must retain `generationId`, `baseRevision`, `snapshotHash`, and the full snapshot, and must not fabricate or reuse expired bindings on its own. For the full protocol, retry rules, and Context update strategy, see the Skill's [`GUIDE.md`](../assets/skills/taphound-ai-journey/GUIDE.md).

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
taphound verify --project . --journey journeys/search.json --json
Parse the JSON; acceptance passes only when exitCode=0.
If it fails, report report.primaryFailure first, and include reportPath.
Do not modify the Journey to mask implementation defects.
```

## Safety and Determinism

TapHound Replay never invokes AI. The Agent may select an existing Journey or propose new steps in a generation session, but the final judgment of Locator, Activity, Layout Diff, risk policy, and Expect is performed by deterministic code. The Agent must not automatically loosen assertions, swap the Package, delete steps, or bypass confirmation after a failure.
