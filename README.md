<p align="center">
  <img src="assets/brand/taphound-mark.svg" width="128" alt="TapHound - AI-Agent-driven Android UI testing and state verification CLI">
</p>

# TapHound

English | [简体中文](./README.zh-CN.md)

> Follow every tap. Catch every regression.

**An AI-Agent-driven CLI for native Android UI testing and state verification.**

TapHound is a TypeScript/Node.js CLI built for **Android AI testing** and **state verification**. From everyday **Android UI automation** to **AI-agent-driven test path generation**, TapHound delivers deterministic recording and replay grounded in a Project Context and live device state. The current development release, TapHound for Android, supports recording native Android workflows and AI-agent-driven journey generation.

The TapHound Journey is a purpose-built JSON protocol with its own recorder, generation, replay, and assertion model. It is distinct from and incompatible with the Android CLI's official Journey concept. TapHound Core never invokes AI models: external agents may analyze source code and propose actions, but state binding, risk confirmation, device execution, final replay, and assertions are all handled deterministically by TapHound.

TapHound only handles verification. Compiling and installing the APK are independent prerequisites, handled by the developer or AI agent in a separate loop:

```
edit code → build APK → install to device → taphound verify → loop until passing
```

## Why TapHound for Android AI Testing?

- **Deterministic Verification:** Leave behind the fragility of scripted UI automation. TapHound ships its own assertion model and replay engine to catch every regression precisely.
- **AI-Agent Native:** Built-in `taphound-journey-brief-author` and `taphound-journey-generator` Skills adapt to agents like Droid, Claude Code, Codex, and Cursor to generate Project Context, per-Case Briefs, and Android test paths automatically.
- **Non-invasive Build:** Focused on testing and verification, TapHound stays independent of APK compilation and install, driving native Android UI automation against an already-installed target APK.

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

- `doctor`: checks Node.js, ADB, Android CLI, app installation, permissions, and device. With `ui.backend=appium-uiautomator2`, it also checks the local Appium server and UiAutomator2 driver. The default runtime backend is Mobile MCP (`runtime.backend=auto`), so it checks the Mobile MCP server instead of the Android CLI and diagnoses the device through Mobile MCP tools; set `runtime.backend=adb` in config (or `TAPHOUND_RUNTIME_BACKEND=adb`) to check the ADB toolchain instead.
- `record`: interactively execute actions and record a Journey.
- `verify`: deterministically replay a Journey and publish a report.
- `observe`: capture a point-in-time device snapshot (foreground, activity, layout, optional logcat) without a session or side effects.
- `project describe`: output stable Android project facts.
- `context list` / `validate` / `status`: inspect or validate a Project Context index and module shards.
- `context generate`: generate Project Context scaffolding from project source (`--force` to overwrite an existing index).
- `context refresh`: recompute Context evidence hashes, including semantic hashes, without re-analyzing source.
- `context rehash`: recompute Project Context shard and index hashes, optionally limited with `--module <id...>`.
- `journey list-flows` / `journey resolve`: validate reusable Flows and resolve
  composed Journey Sources into flat Journey v2 files. `list-flows --include-external`
  also lists External Flows used by `generation bridge --flow`.
- `journey check`: classify every committed Journey under `.taphound/journeys`
  as `fresh`, `stale`, `no-meta`, or `invalid` by comparing its meta sidecar
  bindings (project, config, Context module selection) against the live
  project, and report each Journey's lifecycle state (`verified`, `draft`,
  `stale`, `suspect`, `retired`; invalid Journeys have no lifecycle).
  `--strict` exits non-zero for CI when any Journey is not fresh.
- `generation start` / `observe` / `next` / `step` / `confirm` / `manual` /
  `bridge` / `status` / `recover` / `config idle` / `archive` / `list` /
  `finalize`:
  manage deterministic Journey generation sessions. `bridge` records cross-app
  flows (e.g. camera, picker, share) through a bound External Flow.
  `config idle` hot-adjusts the session's idle policy without restarting, and
  `step --replace <index>` rewinds an active session by deterministically
  replaying the stored prefix and binding a fresh snapshot.
- `init`: install TapHound's two built-in Skills (`taphound-journey-brief-author`, `taphound-journey-generator`) for AI agents.
- `align camera`: probe the device's default camera app and write a deterministic
  `flows/external/camera/photo-capture.json` External Flow. Requires
  `--force` to overwrite an existing flow.
- `ui-cache status` / `ui-cache clear --yes`: inspect or delete only the
  rebuildable `.taphound/build/cache/ui/` indexes; Journeys, reports, and
  Generation evidence are never touched.
- `impact --base <ref> --head <ref>`: map a Git change set onto modules,
  Knowledge screens/anchors/transitions, and Journey selection (P0 directly
  affected, P1 shared screen, P2 adjacent) through read-only analysis of
  `.taphound/context`, `.taphound/knowledge`, and `.taphound/journeys`.
- `verify-changes --base <ref> --head <ref> [--scope p0,p1]`: replay the
  selected Journeys on a real device and report a per-Journey verdict plus an
  overall pass/fail; skips locator-only Journeys (no semantic binding) and
  documents the reason for every skip.
- `local add` / `list` / `inspect` / `remove`: register an unrelated Android
  repository as a Local Target and inspect its resolved path, Git metadata,
  Context state, and Journey count. Local Target validation is dogfooding and
  never publishable. `--target <id>` runs `doctor`, `context
  generate/status/validate`, `verify`, `impact`, and `verify-changes` against a
  registered target; see [Local Target](docs/local-target.md).
- `knowledge status` / `bootstrap` / `goal` / `plan` / `receipts` / `promote` /
  `evolve`: manage committed Anchor, Screen, and Transition knowledge. Runtime
  commands write immutable receipts; only explicit bootstrap, promotion, or
  receipt-folded evolution updates authority. `goal` drafts a strict Goal Spec
  for a known target Screen, and `evolve` folds receipts bound to the current
  Registry hash into Transition observation counts and upgrades `inferred`
  documents to `observed`.
- `generation start --goal <goal.json>` / `generation next`: bind Knowledge
  and a strict Goal, then recognize and execute one known Transition through
  the existing proposal, risk, evidence, and replay controls.
- `benchmark validate` / `list` / `run` / `compare`: replay Benchmark Cases
  against Ground Truth with the `legacy`, `baseFlow`, or `knowledge` engine
  and compare aggregate success, route accuracy, timing, and LLM metrics.
- `journey promote --journey <path> --reason <text>`: promote a replay-verified
  Journey into a durable asset. Promotion re-checks the verification report
  hash and the verified Journey evidence inside the generation bundle before
  flipping the meta sidecar to `promoted`; Journeys that drifted from their
  evidence fail closed.
- `journey retire --journey <path> --reason <text>`: record a retired lifecycle
  state in the meta sidecar; `journey check` then reports it as `retired`.
  `check`, `retire`, and `promote` all accept `--target <id>` for registered
  local targets.

## Configuration

Create `.taphound/config.json` in the Android project. `run.packageName` is required and never guessed from APK filenames or activities; see [`examples/.taphound/config.json`](examples/.taphound/config.json) for a complete example and [`docs/config-schema.md`](docs/config-schema.md) for the full field reference, per-profile recommendations, and the editor-validation JSON Schema.

```json
{
  "version": 1,
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "strategy": "hybrid",
    "pollIntervalMs": 200,
    "stablePolls": 2,
    "timeoutMs": 5000
  },
  "ui": {
    "backend": "auto",
    "snapshotTimeoutMs": 5000,
    "cacheEnabled": true
  },
  "artifactsDir": ".taphound/build/runs"
}
```

`artifactsDir` is optional and defaults to `.taphound/build/runs`.
`ui` is optional, so parsing an existing config does not add fields or change
its Generation binding hash. Runtime defaults to `auto`; explicit backend
choices are `system-uiautomator`, `android-cli`, and `appium-uiautomator2`.
Appium remains explicit-only and fails closed when its provider is unavailable.
`cacheEnabled: false` is the cache-equivalence switch: it disables only the
run-scoped observation cache, never changes locator rules or action behavior.
Persistent UI cache files store resource-ID-based screen/flow contracts and
hashes only—never prior click coordinates, raw page sources, screenshots, or
page text. A candidate always receives a fresh live snapshot before TapHound
resolves its current geometry.
`idle.strategy` defaults to `hybrid`: TapHound uses fast frame counters, then
confirms a stable Core-owned UIAutomator layout. If frames keep rendering,
`hybrid` falls back to structural layout stability instead of timing out only
because the frame counter changes. Use `layoutDiff` to skip frame counters
entirely for apps with known continuous rendering, or `frameStats` only when
pixel-level frame quiescence is required.

`runtime.backend` selects the device runtime backend: `auto` (default) and
`mobile-mcp` route device work through the [Mobile MCP](https://www.npmjs.com/package/@mobilenext/mobile-mcp)
server, while `adb` selects the ADB + Android CLI backend as the explicit
fallback. Device work flows through the Runtime Backend SPI: `observe`,
`verify`, `record`, and `generation` borrow a session per run through the
`RuntimeSessionOpener` port, `align` still routes through the bridge, and
`doctor` is fully backend-aware. Commands that need capabilities the selected
backend lacks (under `mobile-mcp`: process discovery, foreground Activity,
logcat dump) fail closed with `RUNTIME_CAPABILITY_MISSING` (exit code 3), so
`verify`/`record`/`generation`/`observe` keep the ADB execute path until the
upstream Mobile MCP server exposes them. See the
[Runtime Backend SPI](docs/architecture/runtime-backend.md)
for the capability matrix and adoption levels.

Generation binds the normalized configuration when a session starts. Choose
the idle strategy and timeout before `generation start`; after start, any config
change except the idle policy requires a new session. The idle policy can be
hot-adjusted mid-session with
`generation config idle --session <id> ...` when no step is in flight, no
confirmation is pending, and verification has not run.

## Workspace Layout

TapHound keeps one predictable footprint in the Android project. Committed
inputs and outputs live at the top of `.taphound/`; everything ephemeral lives
under `.taphound/build/`, so a single ignore line covers all generated data.

```text
<project>/
  .taphound/
    config.json           # committed TapHound configuration
    .gitignore            # generated once with "build/"; never overwritten
    context/              # committed Project Context bundle
      project-context.json
      modules/*.json
    flows/                # committed reusable navigation prefixes
    sources/              # committed composed leaf Journey sources
    journeys/             # committed Journeys and <name>.meta.json sidecars
    build/                # ephemeral, safe to delete, ignored by Git
      generations/<id>/   # authoritative generation bundles
      jobs/<id>/          # detached finalize stdout and progress
      runs/<runId>/       # verify reports, screenshots, Logcat
```

Add `.taphound/build/` to `.gitignore` and commit the rest. TapHound creates
`.taphound/.gitignore` with `build/` before record, verify, or generation work
and never rewrites a file you already own. `artifactsDir` and `verify
--reports` may point outside `.taphound`, but any path inside `.taphound` must
stay under `.taphound/build/`. Earlier layouts used
`.taphound/generations`, `.taphound/jobs`, and `.taphound/runs`; TapHound stops
with `CONFIG_INVALID` and prints the exact `mv` commands when it finds them.
Root-level timestamped Verify run directories are detected the same way.

## Interactive Recording for Android UI Automation

The TapHound Recorder displays the current layout, lets you choose an action and target, and executes it through ADB. It does not listen for arbitrary touch events. Each successful step automatically records `activity.before` and `activity.after`; failed steps are not added to the Journey; the complete file is written atomically only after you choose Finish.

```bash
taphound record \
  --project /path/to/android-project \
  --config .taphound/config.json \
  --name "Search flow" \
  --output .taphound/journeys/search.json
```

The Recorder does not auto-generate business `expect` assertions. Activity, Element, or Logcat assertions should be added explicitly by developers or external agents. See [Journey Schema](docs/journey-schema.md) for protocol details.

Supported actions include `click`, `longClick`, `inputText`, `swipe`, `scrollTo`, `back`, and `wait`. `click`, `longClick`, `swipe`, `scrollTo`, and `inputText` may target a Knowledge `anchor` in addition to (or instead of) a runtime `locator`. `scrollTo` swipes within a deterministic `container` up to `maxSwipes` times, stopping once the target `anchor` or `locator` resolves uniquely without clicking it.

## AI-Agent-Driven Android Test Path Generation

The repository ships two Skills.
[`taphound-journey-brief-author`](assets/skills/taphound-journey-brief-author/SKILL.md)
generates and maintains the Project Context Bundle from source evidence and
produces one Brief per Case.
[`taphound-journey-generator`](assets/skills/taphound-journey-generator/SKILL.md) drives one
deterministic Journey scenario from Context and live device state through final
Replay.

Requirement analysis, planning, coding, build/install, multi-Case scheduling,
completion gates, and diagnosis belong to external Workflow Skills. Those
orchestrators may invoke TapHound once per independent Case and adapt its
public CLI JSON, Report, and evidence into their own protocols. TapHound does
not prescribe or package a development workflow.

An orchestrator can bind an optional project-relative
`taphound-journey-brief.md` as `journeyBrief: {path, sha256}`. The Brief
provides one Case's preconditions, expected Journey, assertions, implementation
hints, constraints, and evidence references. It is a Skill-level static hint,
not a Core CLI input; validated Project Context, live Snapshots, and final
Replay remain authoritative.

The Journey Skill guides agents such as Droid, Claude Code, Codex, and Cursor:

1. Run the `taphound-journey-brief-author` Skill to generate a compact Project Context root index plus one semantic/evidence shard per Gradle module (one-time; refreshed on demand).
2. Use `context list` to choose Goal-relevant modules and `context validate` / `context status` to check shard, evidence, and inventory freshness.
3. Select reusable Base Flows by their deterministic Activity contract. Their
   first resolved step must start from a stable cold-launch destination, not
   require a transient Splash Activity to remain foreground. For example,
   `core/launch-home` should be `wait: Home -> Home` with an expectation for a
   unique Home element.
4. Start a `generation` session with `--module`. Without `--base-flow`, Core
   force-stops, launches the configured Activity, and waits for the App process
   before creating the session. `run.activity` is only the cold-launch entry;
   the first observation's idle/layout checks determine the stable start after
   redirects. Use `observe --compact` and read its authoritative `snapshotRef`;
   active references use the Store-owned `.<generationId>.work` bundle, and
   successful compact steps return `nextBinding` and `nextSnapshotRef`.
5. Use `generation status` to inspect durable state, including pending and
   expired confirmations. Confirmation defaults to a local TTY; after the user
   explicitly reviews the exact challenge, a sandboxed Agent can pass
   `generation confirm --decision approve|decline`. An interrupted in-flight
   action can only be reactivated with the explicit
   `generation recover --decision retry` acknowledgement because it may already
   have executed.
6. Use `generation finalize --detach` for long replay verification, then poll
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

The device is bound at `generation start`; subsequent `observe`, `step`,
`confirm`, `manual`, `bridge`, `status`, `recover`, and `archive` commands use
that binding via the session. `generation start --external-flow <name...>` binds
named External Flows by content hash so `generation bridge --flow <name>` can
resolve them deterministically later. See the Skill's [`GUIDE.md`](assets/skills/taphound-journey-generator/GUIDE.md) for the full workflow.

Generation may optionally bind a strict Goal Spec and committed Knowledge hash.
Bounded re-planning is limited to Generation and known Transitions. Finalize
still replays the exact candidate Journey from its initial state. See
[Knowledge and Route Planning](docs/knowledge-planning.md).

If Base Flow replay fails, `generation start --json` reports
`FLOW_REPLAY_FAILED` with the Flow name, Verify report path, primary failure,
failed-step Activity/locator/expectation summary, and recovery guidance.
TapHound does not silently skip the Flow or accept a current Home screen as an
exact replay. Repair or re-record it; omit `--base-flow` only when the user
explicitly chooses to bypass reuse.

`generation manual` interactively builds, executes, and records a deterministic
Journey step. Generation step JSON includes phase timing for freshness,
evidence setup, observation, action, idle waiting, expectations, Logcat
collection, and the optional next observation. When a locator or step needs
correction, `generation step --replace <index>` replays the stored candidate
prefix `[0, index)`, truncates the session to that prefix, and binds a fresh
snapshot, so re-proposals continue from the stored prefix instead of
restarting the session; indices inside the bound Base Flow prefix are
rejected.

### Installing the TapHound Testing Skills for Other AI Agents

`taphound init` copies TapHound's two built-in Skills into each agent's Skill directory.
Interactively select at least one agent:

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

The Skills are published with the npm package; `taphound init` copies them from
the package to the target directories. Re-running `init` overwrites existing
files that exist in the payload, but does not remove stale files left in the
target directory from a previous install.

## Deterministic State Verification

```bash
taphound verify \
  --project /path/to/android-project \
  --config .taphound/config.json \
  --journey .taphound/journeys/search.json
```

Temporarily override package, activity, device, or report path:

```bash
taphound verify \
  --project /path/to/android-project \
  --journey .taphound/journeys/search.json \
  --device emulator-5554 \
  --package com.example.app \
  --activity .MainActivity \
  --reports /tmp/taphound-runs
```

For agent invocations:

```bash
taphound verify --project . --journey .taphound/journeys/search.json --json
```

`--json` mode guarantees exactly one final JSON value on stdout; progress and diagnostics go to stderr. See [Agent Integration](docs/agent-integration.md) and [Report Schema](docs/report-schema.md).

## Local Target (real-app validation)

A Local Target is an unrelated Android repository registered with
`taphound local add <id> --path <path> [--package <name>]`, so you can run
TapHound against your own app without copying any TapHound files into it.
Targets are registered in JSON under `benchmarks/` and each keeps a git-ignored
workspace at `.taphound/local/<id>/`. `doctor`, `context`, `verify`, `impact`,
and `verify-changes` accept `--target <id>` to operate on a registered target.
This is dogfooding: the produced Context, Journeys, and reports are working
evidence for the developer loop and **are never publishable**. `generation
--target` is deferred. See [docs/local-target.md](docs/local-target.md).

```bash
taphound local add my-app --path /path/to/app --package com.example.myapp
taphound doctor --target my-app
taphound verify --target my-app --journey search
taphound verify-changes --target my-app --base origin/main --head WORKTREE
```

## Reports

Each verification writes to an independent directory, always containing `report.json` and `summary.txt`, with step logs provided based on actual execution. A final screenshot and full Logcat are collected on a best-effort basis. The original verification failure is preserved in `primaryFailure`; screenshot or logcat collection issues go into `secondaryErrors` and never overwrite an existing original failure. When verification itself passes but collection fails, the first collection error becomes `primaryFailure` (with code `COLLECTION_FAILED`) and the rest enter `secondaryErrors`; corresponding optional artifacts may be missing.

## FAQ

**Q: How does TapHound combine with LLMs for Android AI verification?**
A: TapHound Core never invokes AI models. External AI agents analyze source code and propose actions, while TapHound handles state binding, risk confirmation, device execution, final replay, and assertions to deliver deterministic Android state verification.

**Q: Does TapHound support non-Android platforms?**
A: The current development release is purpose-built for native Android workflows and supports only Android SDK, ADB, and an online emulator or device.

**Q: Does TapHound build or install the APK?**
A: No. Compiling and installing are independent prerequisites handled by the developer or AI agent in the verification loop; TapHound assumes the target APK is already installed.

**Q: Does replay use AI or visual inference?**
A: No. Replay, device operations, and assertions are fully deterministic, with no AI or visual inference.

## Current Limitations

- Only Android is supported, with a single explicitly selected device.
- TapHound does not build or install the APK. It assumes the target app is already installed. Building and installing are done independently by the developer or AI agent in the verification loop.
- The Recorder is a TapHound-mediated interaction flow; it does not observe arbitrary user touches on the device.
- The Recorder only provides swipe for scrollable elements that have bounds from the Android CLI; Replay does not guess swipe regions for elements missing bounds.
- Annotated screenshot fallback applies only to `click` and `longClick`, and requires an explicitly saved `#label`.
- Replay, device operations, and assertions are fully deterministic, with no AI or visual inference.
- The repository provides two Agent Skills installable via `taphound init`, but there is no dedicated SubAgent wrapper yet.
- Regular tests do not require a real device; Replay and Generation device acceptance requires explicitly setting `TAPHOUND_ACCEPTANCE_DEVICE=1` and meeting external Android prerequisites.
