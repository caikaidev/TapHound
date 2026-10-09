# Changelog

## 0.2.0-dev.15 — 2026-10-09

### Added

- `taphound-bug-fix` Skill: fixes one bug from a scenario, a bug-tracker
  ticket, or a crash log with reproduce-first evidence. It reads ticket URLs
  only through the user's reader Skill (placeholder `bug-tracker-reader`;
  `scripts/bug-fix.mjs reader set <skill>` saves it per user, and
  `TAPHOUND_BUG_READER_SKILL` overrides it), normalizes Java/Kotlin, ANR,
  and native crashes and matches a reproduced crash against the report
  (`crash parse` / `crash match`), stops at `NOT_REPRODUCED` when the
  failure cannot be reproduced, and after the fix commits a regression
  Journey and Contract under `.taphound/journeys/bugs/` and
  `.taphound/contracts/bugs/`, gated by `taphound-verify-change` accept
  mode.

## 0.2.0-dev.14 — 2026-10-09

### Added

- `generation recover --decision amend-expect --expect <file>` commits a
  step whose action completed but whose expectation failed, with a
  corrected `element` or `activity` expectation evaluated on the current
  screen, instead of `retry` plus a full-prefix `step --replace`. It never
  touches the device, records `amendment-<id>.json` evidence, is refused for
  risk-confirmed steps, bridge steps, and Logcat expectations, and emits the
  `succeeded` step shape that `envelope.mjs bind` accepts. `generation
  status` reports `recovery.amendExpectAvailable`.

- `generation start --json` reports `timing` (`totalMs` and per-phase
  milliseconds: `contextLoad`, `doctor`, `projectDescribe`,
  `baseFlowReplay` or `appPrepare`, `contextValidation`, `uiSnapshotOpen`,
  `sessionCreate`) so slow starts can be attributed. Output only.

- `click` and `longClick` steps and proposals accept `touchPolicy:
  "element"` for targets that react to touches although neither they nor an
  ancestor report `clickable` (RecyclerView item-touch listeners, WebView DOM
  nodes such as inline mail images). Core touches the element's bounds
  clipped to its ancestors and the display, and the step must prove its
  outcome with an `element` or `activity` expect (or an Activity change)
  that does not already hold before the touch. Generation rejects the policy
  on targets that already have a capable ancestor. Without it, such targets
  keep failing closed.

- `taphound-flash` plans accept `launchTimeoutMs` (default 30000): the cold
  launch, including a first screen that keeps loading or animating, gets its
  own budget instead of `settleTimeoutMs`. `UNSETTLED` names the budget to
  raise.
- A `taphound-flash` `TARGET_AMBIGUOUS` failure lists every match (id, text,
  description, class, bounds) in its message and in `failure.matches`.

### Fixed

- `scrollTo` stops with `SCROLL_TARGET_NOT_FOUND` once 2 consecutive swipes
  leave the container unchanged, naming the direction, instead of spending
  every remaining swipe at a list edge. The docs state that `direction` is
  the finger direction (`up` reveals content below).
- The diagnostics journal keeps Generation-only failure codes such as
  `ACTION_UNSUPPORTED`; they were dropped as a bare `error` status.
- Generation `CONFIG_INVALID` for a config or UI backend that differs from
  the session names the bound and current hashes and says to rerun with the
  `--config` used at `generation start`.
- `envelope.mjs bind` accepts `generation step --replace` output, so no
  extra `observe` is needed after a replace, and explains that a bare
  binding cannot reuse the draft's old `snapshotRef`.
- `generation step --input` with a missing or unreadable envelope file fails
  with `CONFIG_INVALID` (exit 2) naming the path, instead of
  `INTERNAL_ERROR` (exit 4). The journey-generator Skill says to run `step`
  only after `envelope.mjs bind` exits 0 and not to pipe `bind`.
- The Case Suite `ledger.mjs` rejects inline JSON passed to `--input` with
  a usage error instead of `ENAMETOOLONG`, names the invalid field of a
  transition identity, lists the allowed next statuses and the path through
  skipped states for a rejected transition, and allows transition reasons up
  to 1000 characters (was 500), pointing over-long reasons to
  `failure.message` and `nextAction`.
- `generation start --output` fails with a hint that the Journey path is
  chosen at `generation finalize --output`, and `start --help` says so and
  that later commands need the same `--config`.

- `taphound-flash` retries a failing uiautomator dump (for example `null root
  node` while a splash screen starts) until the current wait runs out instead
  of failing the whole run on the first attempt.

### Changed

- `docs/capability-matrix.md` documents UI tree fidelity across backends
  (raw dump versus Appium hierarchy, WebView DOM bounds, non-clickable
  touch targets), and `docs/local-testing.md` explains the Node
  `UNDICI-EHPA` proxy warning and the `NO_PROXY` setting for the local
  Appium server.
- The Brief Author reads touch capability only from `taphound observe`
  snapshots, records which element holds it, and names the outcome a
  `touchPolicy: "element"` step needs when no element does.

- The `taphound-flash` Skill states that visual styles (colors, layout
  details) are out of scope for flash and TapHound alike: Contracts can require
  a screenshot but never compare pixels, so a visual change needs human review.

- The Brief Author subagent role prompts (English and zh-CN) state that
  Briefs are written only under `.taphound/briefs/<caseId>/` or
  `.taphound/suites/<suite-id>/briefs/<caseId>/`, and fit a 2000-character
  subagent prompt field; details stay in `SKILL.md`.

## 0.2.0-dev.13 — 2026-09-29

### Added

- `journey check --journey <path-or-name...>` audits only the named Journeys
  (project-relative path or Journey name). A selector that matches no
  committed Journey fails with `JOURNEY_NOT_FOUND` (exit `2`).

- `scripts/feedback-pack.mjs`, published with the package, packs a redacted
  evidence archive for feedback: every generation-bundle JSON (step
  `timing`, idle telemetry, snapshots, verification reports) plus chosen run
  reports, with package, class, resource id, UI text, Logcat tag/pattern,
  serial, and path values replaced by stable pseudonyms. The pseudonym
  mapping is written beside the archive, never inside it. See
  `docs/diagnostics.md`.

### Changed

- **Breaking (layout):** Journey Briefs and Case Suites are TapHound project
  material and stay under `.taphound/`. `generation start --brief` accepts
  only paths under `.taphound/briefs/` or `.taphound/suites/<suite-id>/`
  (`BRIEF_INVALID` otherwise). The Case Suite `ledger.mjs` keeps each Suite
  in `.taphound/suites/<suite-id>/` (`init` derives it; `--out` is optional
  and must match), accepts a Case Brief only at
  `briefs/<case-id>/taphound-journey-brief.md` inside it, and rejects a
  Suite loaded from anywhere else with `CASE_SUITE_LOCATION`. The Brief
  author Skill defaults to `.taphound/briefs/<caseId>/`. Suites under
  `doc/development/` must be re-initialized.

- **Breaking (report protocol):** each `logcatEvidence` entry carries a
  required `expectationImpact`: `none` when no Logcat expectation failed
  (those expectations fail closed on relevant drops, so the drop is
  non-fatal), `possible` when one failed. The `verify` stderr warning and
  `summary.txt` say "non-fatal" in the first case. Regenerate stored reports.

- `SNAPSHOT_STALE` for a mismatched before Activity names both Activities in
  its message and carries `details: {field, expected, actual}`.

- The Journey generator's `envelope.mjs bind` compares
  `proposal.activity.before` with the bound snapshot's Activity (from the
  full observe/step output, the inline snapshot, or the snapshot file under
  `--project`) and fails offline with `ENVELOPE_ACTIVITY_MISMATCH`. With
  `--out` it reports `activityCheck: "matched"` or `"unverified"`. Its help
  states the revision rule precisely (observe +1, a succeeded step +3).

- The Case Suite `ledger.mjs` names the input, the allowed fields, and the
  shipped template when it rejects an unknown or missing field, and its help
  states the ledger revision rule (+1 per transition or record-flow).

- The Journey generator's step prompt explains that idle detection cannot
  tell a static full-screen spinner from a loaded screen, and binds loading
  screens with an `element` expect (Core returns the matched layout as the
  next snapshot) or a following `wait` step.

### Performance

- `idle.pollIntervalMs` is measured from the start of one poll to the start
  of the next, so a slow structural capture shortens the following sleep
  instead of adding to it. The config docs note that each stable step costs
  about `(polls - 1) × pollIntervalMs`; field data with `pollIntervalMs:
  1000` spent 83% of generation time in idle sleeps, so keep it near `300`.

## 0.2.0-dev.12 — 2026-09-28

### Added

- A local diagnostics journal and `taphound diagnose export`. Each command
  appends a structured line (command path, passed flag names, exit code,
  failure code, UI backend latency histogram and failures, Appium session
  recoveries) to the Git-ignored `.taphound/build/log/events.jsonl`, only
  where the build layout already exists. `diagnose export` writes a
  redacted, strict-schema bundle with recent events and Replay summaries for
  feedback: Activity, Journey, device, and run names become aliases, locator
  values become salted digests, and paths, packages, serials, messages,
  screenshots, hierarchies, and Logcat text are dropped. Opt out with
  `TAPHOUND_DIAGNOSTICS=off`. See `docs/diagnostics.md`.

- `verify --journey` writes a hash-bound process receipt (`receipt.json`)
  beside the published report and prints `receiptPath` in its `--json`
  output. The `taphound-verify-change` UI-refactor helper consumes this
  receipt instead of one an Agent assembled by hand.

### Changed

- When the first step after cold launch cannot find its target
  (`LOCATOR_NOT_FOUND`, `ANCHOR_NOT_FOUND`, `SCROLL_TARGET_NOT_FOUND`), the
  failure message now says TapHound does not reset app data and points at
  persisted app state, which is the usual cause there.

- `UI_SNAPSHOT_FAILED` exits `3` (environment) instead of `1`, and a Replay
  that stops on it or on `UI_BACKEND_UNAVAILABLE` reports status `error`, so
  a Contract Verdict is `inconclusive` instead of `fail`. A UI backend that
  cannot capture the screen is not evidence of a regression.

- `verify` prints a warning on stderr, and `summary.txt` carries one, when a
  run dropped Logcat lines. The report already recorded `logcatEvidence`, but
  a passed run gave no visible sign of it.

- The Journey generator's `envelope.mjs bind` names the accepted `--from`
  shapes (unmodified `generation observe --json` or succeeded
  `generation step --json` output) when the source is rejected.

### Performance

- With the Appium UI backend, `hybrid` idle waits now sample frame stats with
  `dumpsys gfxinfo` instead of capturing a full Appium page source for every
  frame poll. Once frames are silent, `hybrid` confirms with two structural
  captures instead of `stablePolls` + 1. At the default `stablePolls: 3` an
  idle wait on a static Appium screen drops from 7 page source captures to 2,
  and on the system UIAutomator backend from 4 hierarchy dumps to 2.

### Fixed

- The Appium backend recreates its UiAutomator2 session and retries a page
  source read once when the read times out or Appium no longer knows the
  session (HTTP 404). A degraded session previously failed the whole run on
  its first slow read.
- The UI-refactor `compare` helper expected exit code 4 in the receipt of a
  deterministic failed Replay; `verify` exits 1 for such a failure, so a real
  failed run was paused instead of reported as `FAIL`.

- The `taphound` executable is declared as `dist/cli/main.js` instead of
  `./dist/cli/main.js`. npm 12 rejects the leading `./` at publish time
  ("script name ... was invalid and removed"), which could ship a package
  without the `taphound` command.

## 0.2.0-dev.11 — 2026-09-28

### Added

- `taphound-flash`, a standalone smoke-check Skill for right after an AI
  coding change. It needs only adb and Node.js 18+: `scripts/flash.mjs run
  <plan.json>` cold-launches the installed app, runs a short plan of taps,
  typing, and `expect` checks with TapHound's locator rules, wakes the
  screen, and reports one JSON result with a screenshot, UI dump, and crash
  log on failure. It is explicitly not verification evidence.

- Tag-driven releases: pushing `v<version>` runs `.github/workflows/release.yml`,
  which publishes to npm with provenance through Trusted Publishing under the
  version's dist-tag and creates the GitHub Release from this changelog (see
  `docs/releasing.md`).

### Performance

- Replay of a generated Journey skips foreground and process checks that
  would repeat an observation made in the same device epoch (no Layout
  capture, device mutation, completed action, or Expect wait since). Every
  capture is still followed by a check and every mutation preceded by one;
  Expect observations always read the device. On the parity scenarios this
  removes 25% of device calls (19.3 → 14.5 per step).
- Generation no longer re-checks foreground and process identity after an
  observation that reuses an already settled Layout, since the first checks
  already follow its capture: 4 fewer device calls per step.
- The generation session lock no longer syncs its directory on acquire and
  release (the lock excludes other processes as soon as it is linked, and a
  lock surviving a power loss names a dead owner and is reaped). A
  Generation step now issues 44 instead of 74 fsyncs.

### Changed

- Outdated design documents are removed: the two V2 architecture notes, the
  completed plans under `docs/plans/`, the self-verification analysis, and a
  one-off acceptance record. Their durable principles now live in
  `docs/principles.md` ("Outsource mechanics. Own semantics. Verify
  outcomes.", what belongs in Core, and what is out of scope).

- The READMEs describe TapHound as the check on AI-coded Android changes,
  list the five current Skills, and link the Workflow Skills, capability,
  `observe`, and releasing docs. `TODO.md` (a stale manual npm checklist) is
  removed in favor of `docs/releasing.md`; `docs/agent-integration.md` lists
  the shipped Skills, and the two self-verification design documents are
  marked as history and design respectively.

- `taphound-accept` and `taphound-preserve` are merged into
  `taphound-verify-change`, which classifies each change (new behavior with
  or without UI, refactor, UI toolkit migration, structural UI change) and
  routes it to accept or preserve mode. It ships the Workflow manifest JSON
  Schema instead of pointing at TapHound source files that installed
  projects do not have. Delete previously installed `taphound-accept` and
  `taphound-preserve` Skill directories after running `taphound init`.

- The Journey Generator Skill ships a shorter `SKILL.md` (mid-session
  corrections and cross-app bridges moved to `references/`) and no longer
  installs `GUIDE.md`, which moved to `docs/journey-generator-guide.md`. It
  now states that generation proposals always target a `locator`; Knowledge
  Anchors apply to hand-authored Journeys and Contracts replayed by `verify`.

- The `AdbPort` bridge over the Runtime Backend SPI is removed. `align`'s
  camera probe, the generation app preparer, and `doctor`'s install check
  now borrow a session like every other device consumer (closing it when
  done instead of caching one per serial for the process lifetime), and idle
  device profiles read the device identity from the observing session.
- Replay, the Recorder, and Generation share one cold launch. Their failure
  messages now agree: a failed reset says whether it was cancelled, timed
  out, or which exit code it returned (instead of "App reset failed"), and
  Generation reports a missing process as "App process was not found after
  launch".
- The Recorder records a bridge through the same `BridgeRunner` as Replay and
  Generation, and runs each chosen External Step through `ExternalStepRunner`
  before recording it: a step is recorded only if it executes the way Replay
  will execute it (same foreground checks, `resourceId` resolution, action
  capability, and settle wait). A step that fails before acting is reported
  and can be chosen again; a step that acts but never settles now fails the
  bridge, instead of being dropped from the recording while the bridge
  continued from a state the recorded steps no longer describe.

## 0.2.0-dev.10 — 2026-09-26

TapHound's goal is unchanged: an external agent proposes, and a deterministic
Core binds state, executes, replays, and publishes evidence. This release
removes concepts that sat beside that path instead of on it.

### Removed

- **Knowledge route planning.** `knowledge goal|plan|receipts|promote|evolve|bootstrap|feature-map`,
  `generation next`, `generation start --goal`, generation session `version: 2`
  / `planning`, Knowledge Transitions, runtime Knowledge receipts, and the
  `ImpactSet.affectedTransitions` field. Generation now has exactly one
  producer of steps: agent proposals (`generation step`).
- **Local Targets.** The `local` command, every `--target` / `--targets`
  option, `TAPHOUND_TARGETS_HOME`, `.taphound/local/`, and the
  `LOCAL_TARGET_*`, `TARGET_ID_CONFLICT`, `TARGET_CONFIG_INVALID`, and
  `PACKAGE_IDENTITY_MISMATCH` failure codes. Point `--project` at the
  repository instead; use `verify --diff <ref> --head WORKTREE` for
  uncommitted changes.
- **Verification Playbooks** (`playbook validate`, `.taphound/playbooks/`).
  Escalation decisions belong to the external Workflow; reviewer findings still
  enter only through `contract review`.
- **`verify-changes`**, a duplicate of `verify --diff`.
- **`ui-cache`** and the persistent UI screen cache it inspected (nothing wrote
  to it). The in-memory snapshot cache and its report telemetry are unchanged.
- **Engine benchmark** (`benchmark validate|list|run|compare`), which measured
  the removed Knowledge planner.

### Removed compatibility code

TapHound is pre-1.0; persisted formats now have exactly one shape and stale
artifacts must be regenerated.

- Legacy workspace detection (`.taphound/generations|jobs|runs` and root-level
  run directories). Commands only create the `.taphound/build` layout.
- Generation sessions without a bound UI backend and version 1
  RuntimeSnapshots. Sessions always bind `bindings.uiBackend`; snapshots are
  version 2 only.
- `generation finalize --context` and `--allow-evidence-drift`. Finalize
  always uses the session's stored Context snapshot (live drift is a
  warning); a session without one fails with `CONTEXT_INVALID`.
- Optional-for-old-data fields: Journey meta `journeySha256`,
  `bindings.uiBackend`, `replayPolicy`, `contextSelection`, and
  `externalFlows` are required (`bindings.knowledgeHash` is removed);
  sessions require `verificationHistory` and `externalFlows`; Baselines
  require `requiredEvidence`, element facts require `stepIndex` and are
  always `present`. The `meta-legacy` Journey check reason is gone.
- The flat Checkpoint form (`activity`, `screen`, `visibleElements`,
  `absentElements`). Checkpoints use `expect: { allOf, timeoutMs }` only.

### Fixed

- Generation proposal validation reports `LOCATOR_NOT_FOUND` and
  `LOCATOR_AMBIGUOUS` like Replay does (and as the Journey Skill documents)
  instead of mapping every Locator failure to `ACTION_UNSUPPORTED`. Found by
  the new Replay ↔ Generation parity harness.
- Replay now runs External Flow steps with the same implementation as
  Generation (`ExternalStepRunner`): an `absent` element expectation or an
  element predicate inside an External Flow no longer fails Replay (and
  therefore finalization) after passing during generation, and external
  `scrollTo` swipes re-check the escaped package and Activity before each
  mutation. Cancelling a bridge escape wait no longer reports
  `BRIDGE_NO_ESCAPE`.
- Replay verifies that a bridge escapes to the Journey's recorded
  `escapedPackageName` and fails with `EXTERNAL_PACKAGE_MISMATCH` otherwise,
  instead of accepting any foreground change. Replay and Generation now share
  one bridge implementation (`BridgeRunner`).
- Generation touched the center of a clickable ancestor when a Locator
  matched a non-clickable child (for example a row label), which could hit a
  different control covering the row center. Every engine now touches the
  matched element's own point; the capability is still checked on the nearest
  clickable/longClickable element, and a disabled one fails instead of being
  skipped.
- Replay of a generated Journey applies Generation's action-capability rules:
  a click, longClick, or swipe whose target nothing capable handles fails with
  `ACTION_FAILED` instead of tapping a dead element. Recorded Journeys are
  unchanged.

### Fixed (compatibility cleanup)

- Journey meta now records the session's bound External Flows; previously the
  field was always written as an empty array.

### Changed

- The False-Done Benchmark moved out of the published CLI into the repository
  developer tool `npm run bench:false-done -- <validate|run|compare>`
  (`tools/false-done/`).
- Knowledge is a committed, hand- or agent-authored library of Anchors and
  Screens. New `knowledge rehash` rebuilds `.taphound/knowledge/index.json`
  from `anchors/*.json` and `screens/*.json`; `knowledge status` validates it.
  The index no longer has a `transitions` array, and the Knowledge hash no
  longer includes Transitions.

### Performance

- UIAutomator XML parsing validates the layout tree once instead of once per
  ancestor (about 5–6× faster on a 3,300-node tree).
- Locator resolution flattens the tree without re-spreading subtrees and
  caches compiled regex Locators (about 8× faster).
- Recorder and generation target listing uses a document-order index instead
  of per-element scans (4.5 s → 0.25 s on a 3,300-node list-heavy tree; output
  byte-identical).
- The Logcat ring buffer drops old lines in amortized O(1) instead of
  `Array#shift`.
- Device identity for idle profiles is resolved once per run with parallel
  `getprop` calls.
- Generated Replay (finalize and `verify` of a generated Journey) evaluates
  Expect through the same guarded observations as Generation: the first
  element observation reuses the settled post-action Layout, and a passing
  `activity` or `element` Expect no longer re-checks the foreground it just
  proved. A step with such an Expect makes 7 fewer device calls.

### Fixed

- UIAutomator text and content descriptions now decode numeric character
  references such as `&#10;`, so Locators match multi-line text.
- An unescaped `>` inside a quoted XML attribute no longer breaks layout
  parsing.

### Migration

1. Delete `.taphound/playbooks/`, `.taphound/knowledge/transitions/`, and any
   `benchmarks/targets*.json` / `.taphound/local/` directories.
2. Run `taphound knowledge rehash` once to rewrite `index.json` without
   `transitions`.
3. Replace `taphound verify-changes …` with `taphound verify --diff <base> …`.
4. Active generation sessions started with `--goal` cannot be resumed; start a
   new session.
5. Start new generation sessions; sessions and Journey meta sidecars created
   before this release are rejected. Re-finalize Journeys whose meta sidecar
   fails `journey check`, recapture Baselines, and rewrite flat Checkpoints as
   `allOf` with a `timeoutMs`.
