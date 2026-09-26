# Changelog

## Unreleased

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
