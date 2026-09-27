<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - AI-Agent-driven Android UI testing and state verification CLI">
</p>

# TapHound

English | [简体中文](./README.zh-CN.md)

> Follow every tap. Catch every regression.

**An AI-Agent-driven CLI for native Android UI testing and state verification.**

TapHound records, generates, and deterministically replays UI **Journeys** for native Android apps. The current development release is TapHound for Android. It is built for teams whose AI coding agents (Droid, Claude Code, Codex, Cursor, ...) write code faster than people can review it: the agent proposes test steps from your source code and live device state, and TapHound executes, verifies, and reports — deterministically, with no AI or visual guessing inside the replay loop — so "done" means proven on a device.

The TapHound Journey is its own JSON protocol with its own recorder, generation, replay, and assertion model — distinct from and incompatible with the Android CLI's Journey concept.

## How It Works

TapHound Core never invokes AI models. Agents may analyze source and propose actions, but state binding, risk confirmation, device execution, final replay, and assertions are all handled deterministically by TapHound.

TapHound only handles verification. Building and installing the APK are independent prerequisites in the developer/agent loop, which the bundled Skills check at two depths:

```
classify the change → edit code → build & install → taphound-flash (seconds, smoke) → repeat
                                                  → taphound-verify-change (proof) → done
```

The change type picks the proof: new behavior (with or without UI) must pass an Acceptance Contract; a refactor, including an XML → Compose migration, must reproduce previously captured behavior. See [Workflow Skills](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md).

## Capabilities

- **Record** — interactively record a Journey on a real device (`taphound record`).
- **Verify** — deterministically replay a Journey and publish a report (`taphound verify`); `verify --diff <ref>` replays only the Journeys a Git change affects.
- **Generate** — AI-agent-driven Journey generation: evidence-bound steps, risk confirmation for sensitive actions, and a final exact replay before a Journey is published (`taphound generation ...`).
- **Trust chain** — Acceptance Contracts, behavior Baselines, and Failure Classification turn a replay into an auditable verdict.
- **Knowledge** — semantic Anchors and Screens let Journeys survive UI refactors and resource-id renames.
- **Agent Skills** — five installable Skills (`taphound init`): `taphound-flash` (a standalone adb-only smoke check while coding), `taphound-verify-change` (the done-gate: accept new behavior or preserve existing behavior), `taphound-journey-brief-author` and `taphound-journey-generator` (turn a Case into a verified Journey), and `taphound-case-suite` (many Cases, one at a time).

## Requirements

- Node.js 22 or newer
- Android SDK, ADB, and the `android` CLI on PATH
- An online device or emulator with the target APK already installed
- On macOS, grant Android CLI the Accessibility and Screen Recording permissions

`taphound-flash` alone needs only Node.js 18+ and ADB.

Check your environment first:

```bash
taphound doctor --project /path/to/android-project
```

## Installation

```bash
npm ci
npm run dev:setup   # tests, typecheck, lint, build, npm link
```

See the [local testing guide](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md) for tarball and device validation steps, and [Releasing](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md) for how versions are published.

## Quick Start

Create `.taphound/config.json` in your Android project (full reference: [config-schema](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md), complete example: [`examples/.taphound/config.json`](https://github.com/caikaidev/TapHound/blob/main/examples/.taphound/config.json)):

```json
{
  "version": 1,
  "run": { "packageName": "com.example.app", "activity": ".MainActivity" }
}
```

Record a Journey, then replay it:

```bash
taphound record --project . --name "Search flow" --output .taphound/journeys/search.json
taphound verify --project . --journey .taphound/journeys/search.json
```

For AI agents, install the bundled Skills and let the agent drive generation:

```bash
taphound init --agent claude,codex,cursor,droid
```

## Documentation

- [Journey protocol](https://github.com/caikaidev/TapHound/blob/main/docs/journey-schema.md) · [Configuration reference](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md) · [Report schema](https://github.com/caikaidev/TapHound/blob/main/docs/report-schema.md)
- [Workflow Skills and development scenarios](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md) · [Agent integration](https://github.com/caikaidev/TapHound/blob/main/docs/agent-integration.md) · [Journey Generator guide](https://github.com/caikaidev/TapHound/blob/main/docs/journey-generator-guide.md)
- [Acceptance Contracts](https://github.com/caikaidev/TapHound/blob/main/docs/contract-schema.md) · [Baselines & regression](https://github.com/caikaidev/TapHound/blob/main/docs/checkpoint-regression.md) · [Failure classification](https://github.com/caikaidev/TapHound/blob/main/docs/failure-classification.md)
- [Semantic Anchors](https://github.com/caikaidev/TapHound/blob/main/docs/semantic-anchor.md) · [Capability matrix](https://github.com/caikaidev/TapHound/blob/main/docs/capability-matrix.md) · [`observe`](https://github.com/caikaidev/TapHound/blob/main/docs/observe.md)
- [Runtime backends](https://github.com/caikaidev/TapHound/blob/main/docs/architecture/runtime-backend.md) · [Local development & testing](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md) · [Releasing](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md)

## Current Limitations

- Android only, with a single explicitly selected device.
- TapHound does not build or install APKs; the target app must already be installed.
- The Recorder is a TapHound-mediated interaction flow; it does not observe arbitrary user touches.
- Replay, device operations, and assertions are fully deterministic — no AI or visual inference in Core.
