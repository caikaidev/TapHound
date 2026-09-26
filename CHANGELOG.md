# Changelog

## Unreleased

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
