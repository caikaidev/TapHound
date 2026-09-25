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
