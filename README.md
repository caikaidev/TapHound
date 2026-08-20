<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound HoundMark">
</p>

# TapHound

English | [简体中文](./README.zh-CN.md)

> Follow every tap. Catch every regression.

TapHound is a TypeScript/Node.js CLI for recording, generating, and deterministically verifying app journeys. The current development release, TapHound for Android, supports recording native Android workflows and AI-agent-driven journey generation based on a Project Context and live device state.

The TapHound Journey is a purpose-built JSON protocol with its own recorder, generation, replay, and assertion model. It is distinct from and incompatible with the Android CLI's official Journey concept. TapHound Core never invokes AI models: external agents may analyze source code and propose actions, but state binding, risk confirmation, device execution, final replay, and assertions are all handled deterministically by TapHound.

TapHound only handles verification. Compiling and installing the APK are independent prerequisites, handled by the developer or AI agent in a separate loop:

```
edit code → build APK → install to device → taphound verify → loop until passing
```

## Requirements

- Node.js 22 or newer
- Android SDK, ADB, and an online device or emulator
- Target APK already installed on the device (TapHound does not build or install)
- The `android` CLI available on PATH
- On macOS, grant Android CLI the required Accessibility and Screen Recording permissions

Run environment diagnostics first:

```bash
taphound doctor --project /path/to/android-project
```

When `--device` is omitted, exactly one device with status `device` must be connected; use `--device <serial>` to select among multiple devices.

## Installation and Local Development

Install from source:

```bash
npm ci
npm run dev:setup
```

`dev:setup` runs the tests, type-checker, linter, build, built-CLI smoke test,
`npm link`, and a final `taphound --help` check. After it passes, invoke
TapHound directly, for example:

```bash
taphound doctor --project /path/to/android-project
```

Full local quality gate:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

See the [local testing guide](docs/local-testing.md) for source, npm tarball, and Android device validation steps. When switching dev machines, follow the [machine handoff TODO](TODO.md) to track remaining acceptance and npm `dev` pre-release.

## CLI Commands

- `doctor`: checks Node.js, ADB, Android CLI, app installation, permissions, and device.
- `record`: interactively execute actions and record a Journey.
- `verify`: deterministically replay a Journey and publish a report.
- `project describe`: output stable Android project facts.
- `context list` / `validate` / `status`: inspect or validate a v2 Project Context index and module shards.
- `context refresh`: recompute Context evidence hashes, including semantic hashes, without re-analyzing source.
- `generation start` / `observe` / `step` / `confirm` / `manual` / `status` /
  `recover` / `finalize`: manage deterministic Journey generation sessions.
- `init`: install the TapHound AI Journey Skill for AI agents.

## Configuration

Create a `taphound.config.json` in the Android project. `run.packageName` is required and never guessed from APK filenames or activities; see [`examples/taphound.config.json`](examples/taphound.config.json) for a complete example.

```json
{
  "version": 1,
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "pollIntervalMs": 200,
    "stablePolls": 2,
    "timeoutMs": 5000
  },
  "artifactsDir": ".taphound/runs"
}
```

## Interactive Recording

The TapHound Recorder displays the current layout, lets you choose an action and target, and executes it through ADB. It does not listen for arbitrary touch events. Each successful step automatically records `activity.before` and `activity.after`; failed steps are not added to the Journey; the complete file is written atomically only after you choose Finish.

```bash
taphound record \
  --project /path/to/android-project \
  --config taphound.config.json \
  --name "Search flow" \
  --output journeys/search.json
```

The Recorder does not auto-generate business `expect` assertions. Activity, Element, or Logcat assertions should be added explicitly by developers or external agents. See [Journey Schema](docs/journey-schema.md) for protocol details.

Supported actions include `click`, `longClick`, `inputText`, `swipe`, `scrollTo`, `back`, and `wait`. `scrollTo` swipes within a deterministic `container` up to `maxSwipes` times, stopping once the target `locator` resolves uniquely without clicking it.

## Agent-Driven Journey Generation

The repository ships a [`taphound-ai-journey` Skill](assets/skills/taphound-ai-journey/SKILL.md) that guides agents such as Droid, Claude Code, Copilot, and Cursor:

1. Discover Gradle modules and generate a compact Project Context v2 index plus one semantic/evidence shard per module.
2. Use `context list` to choose Goal-relevant modules and `context validate` / `context status` to check shard, evidence, and inventory freshness.
3. Start a `generation` session with `--module`, observe once, then reuse each
   successful step's `nextBinding` and `nextSnapshot` when present.
4. Use `generation status` to inspect durable state. An interrupted in-flight
   action can only be reactivated with the explicit
   `generation recover --decision retry` acknowledgement because it may already
   have executed.
5. Use `generation finalize --detach` for long replay verification, then poll
   `generation status` (or use `--wait`). TapHound publishes the Journey only
   after exact verification passes.

```bash
taphound generation start \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --module :feature:search \
  --device emulator-5554 \
  --json
```

The device is bound at `generation start`; subsequent `observe`, `step`, `confirm`, and `manual` commands use that binding via the session. See the Skill's [`GUIDE.md`](assets/skills/taphound-ai-journey/GUIDE.md) for the full workflow.

### Installing the Skill for Other AI Agents

`taphound init` copies the TapHound AI Journey Skill into each agent's Skill directory. Interactively select at least one agent:

```bash
taphound init
```

Non-interactive mode:

```bash
taphound init --agent claude,codex,cursor,droid
```

Global install (user-level directory):

```bash
taphound init --agent claude --global
```

Supported agents and paths:

| Agent | Project-level path | User-level path |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| Droid | `.factory/skills/` | `~/.factory/skills/` |
| Other | `.agents/skills/` | `~/.agents/skills/` |

The Skill is published with the npm package; `taphound init` copies it from the package to the target directory. Re-running `init` overwrites existing Skill files.

## Deterministic Verification

```bash
taphound verify \
  --project /path/to/android-project \
  --config taphound.config.json \
  --journey journeys/search.json
```

Temporarily override package, activity, device, or report path:

```bash
taphound verify \
  --project /path/to/android-project \
  --journey journeys/search.json \
  --device emulator-5554 \
  --package com.example.app \
  --activity .MainActivity \
  --reports /tmp/taphound-runs
```

For agent invocations:

```bash
taphound verify --project . --journey journeys/search.json --json
```

`--json` mode guarantees exactly one final JSON value on stdout; progress and diagnostics go to stderr. See [Agent Integration](docs/agent-integration.md) and [Report Schema](docs/report-schema.md).

## Reports

Each verification writes to an independent directory, always containing `report.json` and `summary.txt`, with step logs provided based on actual execution. A final screenshot and full Logcat are collected on a best-effort basis. The original verification failure is preserved in `primaryFailure`; screenshot or logcat collection issues go into `secondaryErrors` and never overwrite the original failure; corresponding optional artifacts may be missing.

## Current Limitations

- Only Android is supported, with a single explicitly selected device.
- TapHound does not build or install the APK. It assumes the target app is already installed. Building and installing are done independently by the developer or AI agent in the verification loop.
- The Recorder is a TapHound-mediated interaction flow; it does not observe arbitrary user touches on the device.
- The Recorder only provides swipe for scrollable elements that have bounds from the Android CLI; Replay does not guess swipe regions for elements missing bounds.
- Annotated screenshot fallback applies only to `click` and `longClick`, and requires an explicitly saved `#label`.
- Replay, device operations, and assertions are fully deterministic, with no AI or visual inference.
- The repository provides an Agent Skill installable via `taphound init` for other agents, but there is no dedicated SubAgent wrapper yet.
- Regular tests do not require a real device; Replay and Generation device acceptance requires explicitly setting `TAPHOUND_ACCEPTANCE_DEVICE=1` and meeting external Android prerequisites.
