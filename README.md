<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - AI-Agent-driven Android UI testing and state verification CLI">
</p>

# TapHound

English | [简体中文](./README.zh-CN.md)

> Follow every tap. Catch every regression.

**Agent-first Android change verification and bug fixing, with auditable evidence and optional deterministic Journey replay.**

TapHound defaults to **tap-check** for post-change acceptance and **tap-fix** for reproduce-first bug fixing. Its optional advanced Core records, generates, and deterministically replays UI **Journeys** for Android apps. The current development release is TapHound for Android. It is built for teams whose AI coding agents (Droid, Claude Code, Codex, Cursor, ...) write code faster than people can review it: the agent proposes test steps from your source code and live device state, and TapHound records executable checks and their evidence. The optional Journey/Contract Core runs deterministic replay without invoking a model; the default Field Skills still rely on Agent-authored expectations, whose business meaning must be reviewed against actual requirements.

The TapHound Journey is its own JSON protocol with its own recorder, generation, replay, and assertion model — distinct from and incompatible with the Android CLI's Journey concept.

## How It Works

The default workflow requires **no Journey, Contract, Project Context, or routine user confirmations**. The coding Agent reviews requirements and source, uses shared tools on a bound device, runs related existing tests, checks impacted B…N scenarios, and archives evidence. Device UI backend priority is Mobile MCP → Appium → ADB.

```text
"Verify this change" → tap-check → Target + Existing Tests + Regression gates
"Fix this bug"      → tap-fix   → RED → unchanged-oracle GREEN + related regressions
                                         ↓
                                  feedback.zip
```

Use `taphound init --agent codex` or directly copy the three folders from [field-skills/](./field-skills/README.md). The original Journey/Contract CLI and replay Core remain available **on demand** for durable CI and cross-version comparison.
TapHound Core never invokes AI models. Agents may analyze source and propose actions, but state binding, risk confirmation, device execution, final replay, and assertions are all handled deterministically by TapHound.

The advanced Journey/Contract Core only handles verification. The default Field Skills can orchestrate Android project build/install through the external coding Agent. The following sequence describes the optional **legacy** workflow:

```
classify the change → edit code → build & install → taphound-flash (seconds, smoke) → repeat
                                                  → taphound-verify-change (proof) → done
```

The change type picks the proof: new behavior (with or without UI) must pass an Acceptance Contract; a refactor, including an XML → Compose migration, must reproduce previously captured behavior. See [Workflow Skills](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md).

## Capabilities

- **Default tap-check / tap-fix** — validate requested changes or actual bug RED→GREEN, run related existing tests and impact-based regression checks.
- **Outcome evidence** — link actual checks, versioned expectations, device/APK context, Logcat and a reviewable feedback archive to the decision.
- **No routine user approval** — source-aware expectation review is automatic, but material unsupported expectations remain INCONCLUSIVE.
- **Advanced deterministic replay** — opt in to Journeys/Contracts and Baselines for reusable strict checks and CI.
- **Record** — interactively record a Journey on a real device (`taphound record`).
- **Verify** — deterministically replay a Journey and publish a report (`taphound verify`); `verify --diff <ref>` replays only the Journeys a Git change affects.
- **Generate** — AI-agent-driven Journey generation: evidence-bound steps, risk confirmation for sensitive actions, and a final exact replay before a Journey is published (`taphound generation ...`).
- **Trust chain** — Acceptance Contracts, behavior Baselines, and Failure Classification turn a replay into an auditable verdict.
- **Knowledge** — semantic Anchors and Screens let Journeys survive UI refactors and resource-id renames.
- **Legacy Agent Skills** — six optional Skills (`taphound init --profile legacy`): `taphound-flash` (a standalone adb-only smoke check while coding), `taphound-verify-change` (the done-gate: accept new behavior or preserve existing behavior), `taphound-journey-brief-author` and `taphound-journey-generator` (turn a Case into a verified Journey), `taphound-case-suite` (many Cases, one at a time), and `taphound-bug-fix` (reproduce a reported bug or crash, fix it, and prove the same scenario passes).

## Requirements

- Node.js 22 or newer
- Android SDK, ADB, and project-specific build tools on PATH (the `android` CLI is only required for some advanced Journey/Contract backends)
- An online device or emulator with the target APK already installed
- On macOS, grant Android CLI Accessibility and Screen Recording permissions only when using that optional advanced backend

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

## Quick Start — Field Skills (default)

```bash
taphound init --agent claude,codex,cursor,droid
# Or directly copy field-skills/{tap-check,tap-fix,taphound-flash} into your Agent's Skills directory.
```

Tell the Agent **“验收这次修改”** or **“复现并修复这个 Bug”**. Its result and evidence are saved under `.taphound/feedback/<case-id>/feedback.zip`. No `.taphound/config.json` is required for this default workflow.

Before switching profiles or upgrading a locally edited Field Skill, back up and move the old Skill directory **outside** the Agent Skills folder. The installer refuses incompatible profiles and differing Field payloads without overwriting files. Reinstalling an identical Field payload is safe and repeatable; an upgrade to changed files requires moving the old directory first. The CLI does not automatically delete local customizations.

## What a PASS does—and does not—prove

**PASS applies only to the scenarios actually executed, with required evidence.** It is not proof that all regressions are absent. An Oracle's `confidence: supported` and cited sources are Agent-authored provenance, not machine proof that a requirement was understood correctly. The Agent proposes expectations; the Runner checks executable conditions. A custom script's measured-assertion file is cross-checked against its attached observation JSON, but both are still external-script attestations, not independently observed UI truth. These origins remain distinguishable in Gate evidence. Missing or conflicting essential observations yield `INCONCLUSIVE` rather than an invented green result.

The 62+ local/synthetic tests and GitHub CI do **not** certify real-device Mobile MCP/Appium compatibility. See [Field verification details](./field-skills/README.md) for testing and privacy limitations.

## Optional advanced Journey/Contract workflow

```bash
taphound init --agent codex --profile legacy
```

For persistent deterministic replay (not an everyday acceptance prerequisite), create `.taphound/config.json` in your Android project (full reference: [config-schema](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md), complete example: [`examples/.taphound/config.json`](https://github.com/caikaidev/TapHound/blob/main/examples/.taphound/config.json)):

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

To install the **legacy** Journey/Contract agent workflow:

```bash
taphound init --agent claude,codex,cursor,droid --profile legacy
```

## Documentation

- [Journey protocol](https://github.com/caikaidev/TapHound/blob/main/docs/journey-schema.md) · [Configuration reference](https://github.com/caikaidev/TapHound/blob/main/docs/config-schema.md) · [Report schema](https://github.com/caikaidev/TapHound/blob/main/docs/report-schema.md)
- [Principles](https://github.com/caikaidev/TapHound/blob/main/docs/principles.md) · [Workflow Skills and development scenarios](https://github.com/caikaidev/TapHound/blob/main/docs/workflow-skills.md) · [Agent integration](https://github.com/caikaidev/TapHound/blob/main/docs/agent-integration.md) · [Journey Generator guide](https://github.com/caikaidev/TapHound/blob/main/docs/journey-generator-guide.md)
- [Acceptance Contracts](https://github.com/caikaidev/TapHound/blob/main/docs/contract-schema.md) · [Baselines & regression](https://github.com/caikaidev/TapHound/blob/main/docs/checkpoint-regression.md) · [Failure classification](https://github.com/caikaidev/TapHound/blob/main/docs/failure-classification.md)
- [Semantic Anchors](https://github.com/caikaidev/TapHound/blob/main/docs/semantic-anchor.md) · [Capability matrix](https://github.com/caikaidev/TapHound/blob/main/docs/capability-matrix.md) · [`observe`](https://github.com/caikaidev/TapHound/blob/main/docs/observe.md)
- [Runtime backends](https://github.com/caikaidev/TapHound/blob/main/docs/architecture/runtime-backend.md) · [Local development & testing](https://github.com/caikaidev/TapHound/blob/main/docs/local-testing.md) · [Releasing](https://github.com/caikaidev/TapHound/blob/main/docs/releasing.md) · [Diagnostics and feedback](https://github.com/caikaidev/TapHound/blob/main/docs/diagnostics.md)

## Current Limitations

- Android only, with a single explicitly selected device.
- Advanced Journey/Contract Core does not build or install APKs; the coding Agent using Field Skills may build/install the project.
- The Recorder is a TapHound-mediated interaction flow; it does not observe arbitrary user touches.
- Replay, device operations, and assertions are fully deterministic — no AI or visual inference in Core.
