# Workflow Skills

`taphound init` installs `taphound-case-suite` and `taphound-verify-change`
(accept and preserve modes) alongside the Journey Generator and Brief Author. These
packaged Skills direct external agents to use **existing public CLI commands
only**. Core does not analyze requirements, build/install apps, manage
multi-Case decisions, or invoke a model. No Workflow reads or writes a
generation staging bundle.

## Durable multi-Case Journey suites

`taphound-case-suite` is the orchestration layer above the one-Case Brief
Author and Journey Generator. The caller supplies a complete, user-approved
Case catalog and an explicit project-relative suite directory. Its packaged
`scripts/ledger.mjs` helper:

- freezes `cases.json` and binds its exact-byte SHA-256;
- maintains a strict, revisioned `case-ledger.json` and generated `STATUS.md`;
- permits only one active Case under the serial device policy;
- checks dependency completion and optimistic `expectedRevision`;
- records Case-specific Brief hashes, generation IDs, failures, and exact next
  actions so another agent resumes without chat history;
- validates Base Flow file → resolution manifest → resolved Journey → passed
  independent report binding before recording the Flow;
- requires a verified generation meta, passed finalization report, and a
  passed independent report with a different run ID before `verified`.

The suite catalog and Ledger are committed project material chosen by the
caller, not `.taphound` Core authority. Reports and generation evidence stay
under `.taphound/build/`; the Ledger records paths and hashes without copying
raw Logcat, screenshots, captures, credentials, or user content. Frozen
catalog changes require a new Suite ID. One-device execution is always serial.
See `assets/skills/taphound-case-suite/SKILL.md`.

## Development scenarios

`taphound-verify-change` classifies each AI-coded change before work starts:

| Change | Mode | Gate |
|---|---|---|
| New behavior without UI changes | accept, through an existing UI flow | Contract `pass`, typically with `logcatEvent` assertions on structured app logs |
| New behavior with UI changes | accept, with a newly generated Journey | Contract `pass` |
| Refactor with no UI change | preserve, Baseline | `equivalent: true` |
| UI toolkit migration (XML → Compose) | preserve, large UI refactor | the new Journey proves every frozen observable |
| Major structural UI change in the same toolkit | preserve: Baseline if the old Journey still replays, otherwise large UI refactor | as above |

## Accept and Preserve

Accept proves intentional new behavior with a hash-bound Contract Verdict
`pass` and an independent `verify --contract --policy-from-meta` Replay.
Preserve freezes a passing report/Baseline **before** a refactor, then
replays the same Journey/Contract and policy after the change, accepting only
`baseline compare` with `equivalent:true`. A mixed task uses two separate
Cases. `verify --diff` can choose affected Journeys, but its `overall` status
is neither a Contract Verdict nor a regression comparison.

Each Case stores a manifest at the path returned by
`workflowManifestPath(caseId)` in `src/domain/workspace.ts`, conventionally
`.taphound/build/workflows/<caseId>/manifest.json`. The build directory is
ephemeral and ignored. `WorkflowManifestSchema` in
`src/domain/workflow-manifest.ts` defines a strict, versioned record:

- Case id and Accept/Preserve declaration, redacted requirement source/digest;
- separate implementation and validation-asset diff **paths and SHA-256**;
- Journey/optional Contract/Knowledge hashes and strict meta Replay policy;
- whether `verify --diff` was used, its base/head and selected P0/P1/P2 tiers;
- every CLI argv, process exit code and saved JSON result path;
- pre/post report, Verdict, Baseline and compare result paths as applicable;
- outcome (`verdict` or `equivalent`) and Workflow `PASS`/`FAIL`/`PAUSED`.

`PASS` requires a strict policy, recorded successful commands, a report, plus
a passing bound Verdict for Accept or pre/post reports and an equivalent
Baseline for Preserve. The Skill must validate referenced JSON, hashes and
paths in addition to the structural manifest schema. The installed
Skill ships the structural schema as `schemas/workflow-manifest.schema.json`
(rendered by `npm run skills:schemas`) and states these cross-field rules in
`SKILL.md`, since installed projects have no TapHound source. Missing pre-change
evidence, unavailable strict policy or required human decisions lead to
`PAUSED`. Failed device/Contract/comparison evidence leads to `FAIL`; neither
is re-labeled `PASS`. Keep raw Logcat and captured values outside the
manifest and protect the build directory against symlink escapes and silent
overwrites.

## Independent Preserve handoff

For two agents on different worktrees, the packaged Preserve Skill provides
`scripts/handoff.mjs`. A validates a passing **historical APK** Replay and
captures its Baseline before modifying the app. `prepare` freezes those
assets into a Case directory in an existing shared location. B receives
just the absolute `handoff.md` path, runs `validate` and `stage` against the
target project before device work, then independently replays the same
Journey/strict meta/optional Contract and compares the fresh report to
`<handoff-directory>/baseline.json`. Only `equivalent:true` is Preserve
`PASS`. The Case directory also contains `handoff.json` and per-file
SHA-256 hashes; an MD without its matching bundle, a conflict in B's
validation assets, or absent pre-change evidence is `PAUSED`.

The helper copies the before-run report and optional Verdict, **not** raw
Logcat, screenshots or captured request data. A's locally built APK digest
is an explicit install-provenance **attestation**, not a measurement of the
APK installed on the device; A must separately record the build/install
receipt. This package is a transport and identity check, not a replacement
for Core's strict Replay and Baseline comparison or physical mixed-change
acceptance. See the installed `taphound-verify-change/references/preserve.md` for the input JSON
and exact A/B commands.
Review the JSON evidence before sharing; SHA-256 detects drift but is not
an authenticity signature against someone who can rewrite the shared bundle.

### Large UI-refactor mode

When control IDs, Activities, navigation or the whole layout intentionally
change, the old Journey is not treated as the cross-version interface.
The Preserve Skill's `scripts/ui-refactor.mjs` freezes a behavior Case plus
an old APK's independently replayed evidence. The target agent validates that
bundle, generates a new Journey against the new UI, independently replays it,
and proves the same exact frozen observables. Old and new Journey hashes and
run IDs must differ.

This mode reports **frozen-observable conformance**, not full UI equivalence
and not a successful `baseline compare`. Its v1 oracle supports unique visible
text expectations plus dedicated Checkpoints for present/absent semantic
elements (`text`, `contentDescription`, or an intentionally stable
`resourceId`) and digest-bound structured Logcat events. This covers common
XML → Compose migrations when both implementations expose the same
user-facing semantics, even if action IDs and layout differ. A Compose
`testTag` must first be deliberately exposed to the runtime hierarchy; it is
not assumed to be observable.

Unspecified layout, pixels, accessibility structure, Activities, intermediate
steps, enabled/focus/scroll state and behavior are outside the claim.
Unsupported or vague requirements remain `PAUSED`. Both runs require strict
generation meta and a hash-bound process receipt, so AI-authored prose alone
cannot establish the historical behavior. Exact Case shape and A/B commands
are in the packaged Preserve Skill.
