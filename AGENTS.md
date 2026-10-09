# TapHound Repository Guide

TapHound is an ESM TypeScript/Node.js CLI for recording, generating, and
deterministically verifying native Android journeys. It uses its own strict JSON
Journey protocol, not Android CLI's Journey format. TapHound Core does not invoke
AI models or use visual guessing during replay. External agents may analyze
source and propose generation steps, but TapHound binds state, enforces risk
policy, executes actions, replays the result, and publishes evidence
deterministically.

TapHound does not build or install APKs. The target package must already be
installed before recording, generation, or verification.

`taphound init` scans `assets/skills/` and installs every skill directory
containing a `SKILL.md`. Six skills ship with TapHound:

- `taphound-journey-generator` drives one deterministic Journey generation session.
  Requirement analysis, planning, coding, build/install, multi-Case
  orchestration, completion gates, diagnosis, and IM-Log belong to Workflow
  Skills. `taphound-case-suite` owns durable multi-Case Journey orchestration.
  They consume TapHound's public CLI JSON and evidence, not Core generation
  internals.
- `taphound-journey-brief-author` generates and maintains the Project Context
  Bundle (root index plus one shard per Gradle module) by analyzing source
  evidence through read-only `taphound project`/`context` commands, and
  produces one Journey Brief per Case by combining source analysis with
  read-only `taphound observe`. It is the recommended producer of the Project
  Context and Brief that `taphound-journey-generator` consumes. It uses only read-only
  commands and never modifies device state.
- `taphound-case-suite` freezes one user-approved Case catalog and maintains a
  project-owned, revisioned `case-ledger.json` plus generated `STATUS.md`.
  It serializes device mutation to one Case, records recovery and next actions,
  validates hash-bound Base Flow proofs, and marks a Case verified only after
  generation finalization plus a different-run independent Replay. Its helper
  never reads or writes Core generation bundles directly.
- `taphound-verify-change` proves one code change per Case with an
  independent strict Replay and a redacted provenance manifest under the
  ignored build subtree. Accept mode (new behavior, with or without UI) gates
  on a hash-bound Contract Verdict `pass`; preserve mode (refactors) gates on
  a pre-change Baseline and `equivalent: true`. For two worktrees it
  packages a digest-checked `handoff.md` entry and portable pre-change
  evidence; the APK install hash is Agent A's attestation, not a measurement
  of the installed device binary. UI toolkit migrations and major structural
  UI changes use its `ui-refactor.mjs` gate: A freezes a behavior Case and a
  real old-APK Replay, B generates a different Journey and independently
  proves the same exact observables (frozen-observable conformance, not Core
  Baseline equivalence). It ships the manifest JSON Schema rendered from
  `src/domain/workflow-manifest.ts` (`npm run skills:schemas`).

- `taphound-flash` is a standalone smoke check that needs only adb and
  Node.js: its zero-dependency `scripts/flash.mjs` runs a short JSON plan
  (tap, type, back, wait, expect, expectActivity) against the installed app
  with TapHound's locator rules (exact match, ambiguity fails, taps land on
  the matched element's point) and prints one JSON result. It never counts
  as evidence; `test/skills/flash.test.ts` drives it with a stateful fake
  adb (`test/fixtures/bin/fake-adb.mjs`).
- `taphound-bug-fix` fixes one bug from a scenario, a bug-tracker ticket, or
  a crash log under the rule "no reproduction, no fix": it reads the report
  (ticket URLs through the user's reader Skill, `bug-tracker-reader` by
  default, saved per user with `scripts/bug-fix.mjs reader set`), reproduces
  the failure in a held generation session (`APP_CRASHED` matched by `crash
  match`, or a failed correct-behavior expectation), stops at
  `NOT_REPRODUCED` otherwise, then fixes, finalizes a regression Journey and
  Contract under `.taphound/journeys/bugs/` and `.taphound/contracts/bugs/`,
  and gates through `taphound-verify-change` accept mode. Its helper is
  tested by `test/skills/bug-fix.test.ts`.

The Journey Skill may consume one optional project-relative
`taphound-journey-brief.md` through a `journeyBrief: {path, sha256}` binding.
Briefs live only under `.taphound/briefs/` or `.taphound/suites/<suite-id>/`
(`JOURNEY_BRIEF_ROOTS`); `generation start --brief` rejects other paths with
`BRIEF_INVALID`, and the Case Suite helper keeps each Suite in
`.taphound/suites/<suite-id>/` (`CASE_SUITE_LOCATION` otherwise).
This is a Skill convention, not a Core CLI input. The Brief is untrusted static
Case context; Project Context, live Runtime Snapshots, risk policy, execution,
and final Replay remain authoritative.

`docs/principles.md` holds the product and architecture principles ("Outsource
mechanics. Own semantics. Verify outcomes.", what belongs in Core, and what is
out of scope); check a new feature against it.

## Toolchain and Commands

- Use Node.js 22 or newer. The current ESLint toolchain requires Node 22.13+ or
  24+; avoid Node 23.
- Install locked dependencies: `npm ci`
- Validate, build, and globally link the current checkout: `npm run dev:setup`
- Run all tests: `npm test`
- Run one test file: `npm test -- test/domain/journey.test.ts`
- Run one named test:
  `npm test -- test/domain/journey.test.ts -t "parses a valid TapHound Journey fixture"`
- Run coverage: `npm run coverage`
- Type-check without emitting: `npm run typecheck`
- Lint: `npm run lint`
- Rebuild generated `dist/`: `npm run build`
- Smoke-test the built CLI: `node dist/cli/main.js --help`

The documented local quality gate is:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

Releases are cut by pushing a `v<version>` tag matching `package.json`;
`.github/workflows/release.yml` reruns the gate, publishes to npm through
Trusted Publishing under the version's dist-tag (`dev` for `-dev.N`), and
creates the GitHub Release from that version's `CHANGELOG.md` section (see
`docs/releasing.md`). `npm test` fails when the package version has no
CHANGELOG section.

Real-device acceptance is opt-in and separate from the normal suite. Build first,
then provide Android SDK, ADB, Android CLI, an online device, and the already
installed demo APK:

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:device
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation
```

The first command validates Replay; the second validates
`generation start → observe → step → finalize`. See `docs/local-testing.md` for
demo build/install, tarball, and machine-validation steps. Never report normal
tests as evidence that device acceptance passed.

## Architecture

The code follows ports and adapters:

- `src/domain/` owns strict Zod schemas and inferred protocol types for config,
  project context, layouts, locators, journeys, proposals, generation state,
  failures, and reports. These schemas are the external and persisted contracts.
- `src/ports/` defines boundaries for ADB, Android CLI, process execution,
  clocks, prompts, project inspection, artifact/session storage, and publishing.
- `src/adapters/` implements those ports using child processes, the filesystem,
  the system clock, and Inquirer.
- `src/application/` contains deterministic use cases for diagnosis, project and
  context inspection, recording, generation, interaction, waiting, assertions,
  verification, collection, and publication.
- `src/cli/` contains Commander commands, JSON/text output handling, and the
  composition root. `createProductionDependencies` in
  `src/cli/dependencies.ts` wires production adapters into application services.
  `src/cli/main.ts` is the executable entry point.

The CLI exposes `doctor`, `record`, `verify`, `contract`, `observe`,
`project`, `context`, `journey`, `generation`, `knowledge`, `baseline`,
`failure`, `init`, `align`, `impact`, and `diagnose`. Keep external tools and
filesystem effects behind ports so application tests can inject fakes.

Repository-only developer tools live under `tools/` (type-checked, linted,
and tested, but not built into `dist/` or published). The False-Done
Benchmark (`npm run bench:false-done -- <validate|run|compare>`) measures
whether `verify --contract` catches agent false completions; see
`docs/false-done-benchmark.md`.

### Runtime Backend SPI

Device work flows through the Runtime Backend SPI
(`src/ports/runtime-backend.ts`): a `RuntimeBackend` lists devices and opens
serial-bound `RuntimeSession`s. `AdbRuntimeBackend`
(`src/adapters/runtime/`) composes the existing ADB/Android CLI adapters
without reimplementation; `FakeRuntimeBackend` serves unit tests; `MobileMcpRuntimeBackend` (`src/adapters/runtime/mobile-mcp/`) runs
device work through the Mobile MCP server over stdio. Every device
consumer borrows a session through the `RuntimeSessionOpener` port
(`withRuntimeSession` always closes it) and hands its `AdbPort`-shaped helpers
the serial-bound `runtimeSessionPortViews`, so backend selection is a wiring
and config change only. `openSession` performs no device I/O; layout snapshot
providers open lazily through `session.openUiSnapshots()`. Capability-gated
members (`annotatedScreens`, `startActivityByIntent`) are `undefined` when
unsupported and fail closed with `RUNTIME_CAPABILITY_MISSING` (exit code 3),
which names the `runtime.backend` / `TAPHOUND_RUNTIME_BACKEND` escape hatches.
`config.json` selects the backend through
`runtime.backend` (`auto` | `adb` | `mobile-mcp`); `auto` and `adb`
resolve to the ADB backend, `mobile-mcp` explicitly selects Mobile MCP, and the
`TAPHOUND_RUNTIME_BACKEND` environment variable overrides
the config per invocation. A missing `mcp-server-mobile` binary fails with the
coded `ENVIRONMENT_MISSING_TOOL` and a remediation message naming the install
command and the ADB escape hatch. Independently, `ui.backend=auto` prefers
Appium UiAutomator2, then system UIAutomator, then Android CLI. Commands that
need capabilities the selected
backend lacks (`verify`, `record`, `generation`, `observe`, `align`) fail
closed; `observe`, `verify`, `record`, and `generation` borrow a session per
run through the `RuntimeSessionOpener` port (the Level 1 session-first
services; `VerifyRuntime` feeds its unchanged `AdbPort`-shaped helpers
through the `RuntimeSessionPortViewsFactory` port, and `RecorderService`,
`RuntimeObserver`, `GenerationStepExecutor`, `GenerationAppPreparer`, and
`align`'s camera probe follow the same pattern); `doctor` and `align` list
devices through `RuntimeBackend.listDevices`.
See `docs/architecture/runtime-backend.md` for the SPI contract, adoption
roadmap, and Mobile MCP flip checklist.

### Host Project Workspace

`src/domain/workspace.ts` is the single source of truth for the host project
layout; derive every path from it instead of writing `.taphound` literals:

```text
<project>/
  .taphound/
    config.json           # committed TapHound configuration
    .gitignore            # generated once with "build/"; never overwritten
    context/              # committed Project Context Bundle
    flows/                # committed reusable Flow prefixes
      external/           # committed project External Flows (bridge auto replay)
    sources/              # committed composed leaf Journey sources
    journeys/             # committed Journeys and <name>.meta.json sidecars
    contracts/            # committed Acceptance Contracts
    knowledge/            # committed semantic Anchors and Screens (+ index.json)
    baselines/            # committed behavior Baselines
    briefs/               # committed standalone Journey Briefs
    suites/<suite-id>/    # committed Case Suites (catalog, Ledger, Briefs)
    build/                # ephemeral and Git-ignored
      generations/<id>/   # authoritative generation bundles (+ .locks)
      jobs/<id>/          # detached finalize stdout and progress
      runs/<runId>/       # verify reports, screenshots, Logcat
      workflows/<caseId>/ # ephemeral Workflow provenance and command JSON
      log/                # local diagnostics journal (events.jsonl) and salt
      diagnostics/        # redacted bundles from `diagnose export`
```

`src/cli/main.ts` journals each finished invocation (command path, passed
flag names, exit code, structured JSON outcome, UI backend latency) into
`build/log/` only where the build layout already exists; `diagnose export`
builds an allowlisted, strict-schema bundle from it with aliases and salted
locator digests. Neither may carry paths, package/Activity/Journey names,
locator values, serials, or free text (see `docs/diagnostics.md`).
`scripts/feedback-pack.mjs` (published, zero-dependency, tested by
`test/scripts/feedback-pack.test.ts`) is the evidence-level complement: it
packs generation-bundle and run-report JSON with identifiers replaced by
stable pseudonyms and writes the pseudonym mapping beside, never inside, the
archive.

`artifactsDir` is optional and defaults to `.taphound/build/runs`. Core
artifacts must stay under `.taphound/build`; the same boundary applies to
`verify --reports`.
`record`, `verify`, and every `generation` subcommand initialize the safe
build layout and `.taphound/.gitignore` before device work.

TapHound is pre-1.0: persisted protocols (sessions, snapshots, meta sidecars,
Baselines, Knowledge indexes) have exactly one current shape. Do not add
compatibility readers, optional-for-old-data fields, or migration shims;
regenerate stale artifacts instead.

### Verification Flow

`VerifyRuntime` checks installation, starts Logcat, force-stops and cold-launches
the app, waits for process and Activity readiness, and runs Journey steps through
`StepRunner`. Replay, the Recorder, and Generation share one cold launch
(`coldLaunchApp` in `src/application/runtime/cold-launch.ts`: force-stop,
launch, wait for the process) and differ only in how they report its failure.

`VerifyInput` accepts optional `hooks` (`beforeSteps`/`afterSteps`, see
`src/application/runtime/verify-runtime.ts`). Each hook receives the device
ports plus a `UiSnapshot` and returns
`{ status: "passed"|"failed"|"unresolved", message? }`. Hooks never mutate the
replay report or exit code; a throwing hook becomes an `unresolved` outcome
collected in `VerifyResult.hookOutcomes`. `beforeSteps` reuses the readiness
snapshot; `afterSteps` captures one fresh snapshot only when configured.

`verify --contract` validates an Acceptance Contract
(`src/domain/contract.ts`, `src/application/contract/`): a hash-bound Journey
reference plus preconditions, post-journey assertions, and evidence
requirements. The Verdict (`pass`/`fail`/`inconclusive`/`needsReview`/`invalid`)
is one JSON value on stdout and is written as `verdict.json` beside
`report.json`; see `docs/contract-schema.md`. Knowledge-backed terms (`screen`,
`anchor`) require a loadable Knowledge registry and fail closed with
`CONTRACT_KNOWLEDGE_UNAVAILABLE`. `verify --diff <ref>` is the Agent-facing
diff mode (see `docs/agent-integration.md`): it routes through the shared
`runDiffVerification` (`src/cli/diff-verification.ts`) — git diff → ImpactSet → P0/P1/P2 Journey selection → per-Journey
verify → one `overall` verdict; `--base` defaults to the `--diff` ref when
`--base` is omitted, `--head` defaults to HEAD (use `WORKTREE` for uncommitted changes). `contract review` merges externally produced
reviewer findings into a stored Verdict: `pass`/`inconclusive` may escalate to
`needsReview`, but a deterministic `fail`/`invalid` is never rewritten; the
Source-of-Truth hierarchy is documented in `docs/source-of-truth.md`.
`baseline capture`/`baseline compare` implement the deterministic behavior
Baseline and Regression Comparator (`src/application/checkpoint/`): a
Baseline freezes activity sequence + element presence/screen facts from a
passed report, and the pure `compareRegression` reports every drifted fact as
a `RegressionDiff`; `equivalent: true` only when every fact reproduces (see
`docs/checkpoint-regression.md`). `failure classify` maps a failed report's
primary failure into a structured `FailureClassification`
(`src/domain/failure-classification.ts`): the type and likely stage are pure
maps from the failure code (`FAILURE_CODE_TYPES`/`FAILURE_TYPE_STAGES`, all
codes covered by a taxonomy test), expected/actual and evidence refs are
derived from report facts — offline, deterministic, no model call (see
`docs/failure-classification.md`).

Under the generated Replay policy, `StepRunner` keeps foreground and process
proofs per device epoch: a Layout capture, a device mutation, a completed
action, or an Expect wait starts a new epoch, and a check that would repeat
one already made in the current epoch is skipped. Every capture is still
followed by a check and every mutation preceded by one; Expect observations
always read the device because they watch the app change on its own.

Each step checks the before Activity, resolves a deterministic locator, applies
an explicitly configured annotated-label fallback only when eligible, executes
the ADB action, waits for layout stability, checks process and after Activity,
and evaluates any explicit expectation. Replay stops at the first primary
failure. Final screenshot and Logcat collection still run; collection failures
become secondary errors instead of replacing the primary failure.
`ReportWriter` and `ArtifactStore` publish each completed run atomically.

Replay and Generation run bridge steps through one shared implementation
(`BridgeRunner` and `ExternalStepRunner` in
`src/application/interaction/external-step-runner.ts`): trigger, escape
detection, escaped-package policy, external steps, return wait, and settle.
Replay requires the escaped package to equal the step's recorded
`escapedPackageName` (`EXTERNAL_PACKAGE_MISMATCH` otherwise); Generation
checks the scenario's known system packages (`SCENARIO_PACKAGE_MISMATCH`).
For `bridge` steps with `replayMode: "auto"`, `StepRunner` executes the inline
`externalSteps` between escape detection and return wait: each external step
resolves a `resourceId`-only locator (no annotated fallback), executes the
action inside the escaped package, and checks the optional `expectedActivity`.
A locator mismatch fails with `LOCATOR_NOT_FOUND`; an activity mismatch fails
with `EXTERNAL_ACTIVITY_MISMATCH`; a foreground that leaves the escaped package
fails with `EXTERNAL_PACKAGE_MISMATCH`. A non-interactive finalize (no TTY)
rejects any Journey containing a `replayMode: "manual"` step with
`MANUAL_STEP_REQUIRED`; auto-mode bridge steps bypass this guard.

### Recorder Flow

`RecorderService` checks installation, resets and launches the app, reads each
layout, prompts for an action and deterministic target, executes it through the
shared interaction and idle abstractions, and captures before/after Activities.
Only successful steps enter the Journey. Cancellation or failure does not write
a partial Journey, and the recorder does not invent business `expect`
assertions.

For `bridge` actions, the recorder selects a scenario and return timeout,
then runs the same `BridgeRunner` as Replay and Generation with a `drive`
external phase: it records external steps
(click/longClick/inputText/swipe/scrollTo/back/wait/finish) against the
escaped package with `resourceId`-only locators (v1 XML-only restriction),
running each chosen step (except `scrollTo`, already scrolled while choosing)
through `ExternalStepRunner` so only a step that replays is recorded. A step
that fails before acting is reported and can be chosen again; one that acts
but never settles fails the bridge. Steps are written inline with
`replayMode: "auto"`, `escapedPackageName`, and the captured `externalSteps`
so replay and finalize can verify them deterministically. If the trigger does
not cause an escape, the recorder skips the bridge step.

### Alignment Flow

`align camera` is the device-aware companion to `init`. It probes the
connected device's default camera app by sending
`am start -W -a android.media.action.IMAGE_CAPTURE`, waits for the camera
package and Activity to stabilize, dumps the layout, and finds the shutter
button from an enabled clickable element using `contentDescription` keywords
or deterministic `resourceId` tokens. After tapping the shutter it captures
the stable review Activity and finds the confirm/done button using the same
two-stage lookup. ResourceId tokens are ordered by semantic specificity, so
an explicit `done_button` wins over a clickable container whose ID merely
contains a lower-priority `save` token. If the camera leaves the foreground without a confirm
button, the generated flow has two steps (wait, shutter). If it remains
foreground, a unique resourceId-backed confirm button is required and the
flow has three steps (wait, shutter, confirm); missing or non-resourceId
confirm controls fail closed instead of generating a shutter-only flow.

The probe writes a project-level External Flow to
`.taphound/flows/external/camera/photo-capture.json` through the registry's
atomic `write` method. `--force` is required to overwrite an existing flow.
`--json` skips the interactive confirm prompt and emits a single JSON value.
The probe always `forceStop`s the camera app in a `finally` block, even on
failure, so no camera instance is left open after alignment.

`align camera` requires a valid `.taphound/config.json`. Device selection mirrors `doctor`: auto-select when exactly
one device is online, otherwise require `--device`. Missing or offline devices
yield `ALIGN_DEVICE_UNAVAILABLE` (exit code 2).

### Project Context and Generation Flow

`ProjectDescriber` emits stable package and launch facts. Project Context is a
Bundle: a compact root index plus one semantic/evidence shard per
Gradle module. `ContextLoader` safely loads selected modules and dependencies;
`ContextValidator` validates the resolved project identity and evidence.
Per-module inventory path-set hashes detect newly added and removed manifest,
source, layout, and navigation files. `ContextRefresher` recomputes evidence
hashes for an existing Bundle: it backfills the optional `semanticSha256`,
rehashes formatting-only changes, and repairs drifted shard hashes, but it
blocks on semantic, inventory, or unresolved-evidence drift instead of
inventing module semantics.

Generation is a revisioned, evidence-backed state machine:

1. `GenerationStarter` validates and hashes the project, config, resolved
   Context selection, one device, and interaction policy, then creates an
   authoritative session. Application modules are always selected; requested
   feature modules expand declared dependencies. `--external-flow <name...>`
   binds named External Flows by content hash so `generation bridge --flow`
   can resolve them deterministically later.
2. `RuntimeObserver` captures layout and screenshot evidence, hashes the
   snapshot, writes it through the Store, and atomically advances the session
   revision. The returned `snapshotRef` is generated by the Store and is
   immediately readable: while the session is active it points into the
   Store-owned `.<generationId>.work` staging bundle; publication atomically
   moves the same evidence into the final `<generationId>` bundle, and the
   Store then returns final-bundle references. Compact CLI output omits
   duplicate inline snapshots but never replaces the full referenced snapshot
   required by proposal envelopes.
3. `GenerationStepExecutor` accepts only proposals bound to the current session
   revision and snapshot. It re-observes freshness, applies risk confirmation,
   executes deterministically, records evidence, commits successful steps, and
   returns a bound post-action snapshot reference when that capture succeeds,
   and records per-phase timing for freshness, evidence setup, observation,
   action, idle, expectations, Logcat, and next observation. When a proposal's
   Locator uses `index`, Core binds versioned, non-geometric semantic evidence
   of the selected element into the persisted step; Replay recomputes it
   before mutation and fails with `LOCATOR_NOT_FOUND` on mismatch, bypassing
   annotated fallback. An indexed Locator whose target is not on the
   bound snapshot (for example an expectation target that appears only after
   the action, or an off-screen `scrollTo` target) carries no evidence and
   keeps ordinal behavior.
   For `bridge` proposals with `--flow`, the executor resolves the bound
   External Flow, clicks the trigger, detects the escape, executes each flow
   step inside the escaped package with `resourceId`-only locators, waits for
   return, and stamps the resolved steps as `externalSteps` with
   `replayMode: "auto"`. Flow resolution failures yield `EXTERNAL_FLOW_NOT_FOUND`
   or `EXTERNAL_FLOW_STALE`; external step failures yield `EXTERNAL_PACKAGE_MISMATCH`,
   `EXTERNAL_ACTIVITY_MISMATCH`, `EXTERNAL_STEP_FAILED`, or
   `EXTERNAL_LOCATOR_STRICTNESS`.
4. `GenerationFinalizer` revalidates all bindings, resets the app, replays the
   complete candidate Journey through `VerifyRuntime`, and publishes the Journey,
   metadata, report, receipt, and manifest only after exact verification passes.
   The `--output` Journey path must stay outside `.taphound/build`, which is the
   project-bound authority subtree; `.taphound/journeys/<name>.json` is the
   conventional destination. A non-interactive finalize (no TTY) rejects any
   Journey containing a `replayMode: "manual"` step with `MANUAL_STEP_REQUIRED`;
   auto-mode bridge steps bypass this guard.

`generation status` exposes pending confirmation expiry plus durable step and
verification ownership. Risk confirmations default to a local TTY. After a
human explicitly approves or declines the exact displayed challenge, a
sandboxed caller may use `generation confirm --decision approve|decline`; an
Agent must never infer approval or apply it to another challenge.
Approved challenge ID and approval mode are persisted atomically in the
in-flight attempt before device mutation, then copied into successful or failed
step result evidence for audit.
`generation recover --decision retry` is the general CLI transition out of an
interrupted action or dead receipt-free verification attempt.
`generation recover --decision amend-expect --expect <file>` is the narrow
alternative for an unconfirmed step whose action completed and only its
expectation failed: `GenerationStepExecutor.amendExpectation` evaluates a
new `element`/`activity` expectation on the current screen without device
mutation and commits the step through the Store's `amendStep`
(`recoveryRequired` → `active`, exactly one appended step), recording
`amendment-<id>.json` evidence. The explicit
decision is required because the interrupted action or replay may already have
produced business side effects. Its result distinguishes step from verification
recovery and names the next action; verification recovery requires rerunning
`generation finalize`. A completed deterministic verification failure instead
uses `generation reopen --reason <text>`, which preserves the failure in
`verificationHistory` before allowing `generation step --replace <index>`.
Long finalization can run with `--detach`; job stdout and progress stay outside
the authoritative generation bundle, and an early child crash writes a
structured `DETACHED_PROCESS_CRASHED` result instead of leaving empty output.

`FileSystemGenerationSessionStore` owns `.taphound/build/generations` and is the
authoritative persistence boundary for generation state and immutable evidence.
Its lock (`SessionLock`), state transition rules, and filesystem primitives
live beside it in `src/adapters/filesystem/generation-store/`; the
`generation` CLI subcommands are grouped under `src/cli/commands/generation/`.
It creates the ephemeral build subtree and `.taphound/.gitignore` on demand. Its
revision checks, locking, atomic renames, path validation, recovery state, and
core-identity invariants are part of the protocol; do not bypass them with
direct filesystem writes.

### Knowledge and Journey Lifecycle

Knowledge (`.taphound/knowledge/`) is a committed library of semantic Anchors
and Screens authored by humans or agents. `index.json` binds every document by
content hash; `knowledge rehash` is its only writer and rebuilds the index from
`anchors/*.json` and `screens/*.json` (file names must equal document ids,
Screen references must resolve, and the revision only increases when content
changes). `knowledge status` validates and hashes the Registry. Loading a
document whose bytes no longer match the index fails closed as stale. Core
never plans routes or infers Knowledge; Anchors and Screens are consumed by
Replay, Contracts, Checkpoints, and `impact`.

`journey promote --journey <path> --reason <text>` completes the Journey
lifecycle `verified → promoted`. It re-hashes the generation bundle's
verification report, compares the exported Journey against the bundle's
verified Journey evidence, and rewrites the meta sidecar to
`status: "promoted"` with `promotion: {promotedAt, reason}` only when every
check passes. Missing evidence, hash drift, a modified Journey, or an already
promoted sidecar fails closed at exit code 2.

`journey check` reports the deterministic lifecycle state of every Journey
(or only those named by `--journey <path-or-name...>`):
`verified` (bindings fresh), `draft` (no generation meta), `stale` (project
or module evidence drifted), `suspect` (config-only drift), and `retired`
(explicitly retired), with invalid Journeys reported without a lifecycle
state. `journey retire --journey <path> --reason <text>` records
`retired: {retiredAt, reason}` in the meta sidecar; retiring a Journey
without meta fails with `META_MISSING` and a second retire fails with
`JOURNEY_ALREADY_RETIRED` (both exit code 2).

## Protocol and Implementation Constraints

- The project uses ESM with NodeNext resolution. TypeScript source imports use
  `.js` suffixes because those paths must work in emitted JavaScript.
- TypeScript is strict, with exact optional properties and unchecked index
  access. ESLint uses strict type-aware rules and requires explicit return types.
- Protocol schemas use `z.strictObject`; unknown fields are intentionally
  rejected. Coordinate schema, inferred types, runtime behavior, docs/examples,
  fixtures, and tests whenever a protocol changes.
- Config has no build or artifact input because TapHound does not compile.
  Report `schemaVersion` is `4`; installation failure is `APP_NOT_INSTALLED`
  with exit code 3.
- Locator priority is fixed: `resourceId`, then `text`, then
  `contentDescription`. Missing or ambiguous matches fail rather than selecting
  heuristically.
  Action targets share one rule (`resolveActionTarget` in
  `src/application/interaction/action-target.ts`) across Generation, its
  proposal validator, generated Replay, and External Flow steps: click and
  longClick reach the nearest capable element but touch the matched
  element's own point; swipe needs scrollable bounds. An explicit
  `touchPolicy: "element"` on a click or longClick skips the capability
  rule and touches the matched element's visible center (bounds clipped to
  ancestors and the display) for RecyclerView item-touch listeners and
  WebView DOM nodes; the step must prove its outcome with an `element` or
  `activity` expect (or an Activity change) that does not already hold
  before the touch.
- Journey `click`, `longClick`, `swipe`, `scrollTo`, and `inputText` steps may
  express their target as a semantic Knowledge `anchor` (an id from
  `.taphound/knowledge/anchors/`) instead of or alongside `locator`. Replay
  resolves the anchor against the fresh snapshot first (alias-free element
  locator identity; window/activity identities fail closed); when the anchor
  does not resolve and the step also carries a `locator`, that locator is used
  as an explicit fallback and the report records
  `anchor: { status: "locatorFallback" }`. An anchor-only step that fails
  resolves with `ANCHOR_NOT_FOUND` (or `ANCHOR_AMBIGUOUS` when the anchor
  resolves to more than one element), and a step that targets an anchor while
  verify has no anchor resolver configured also fails closed. `scrollTo` and
  `inputText` share this behavior: `scrollTo` resolves the anchor target to
  element bounds before swiping, and `inputText` taps the resolved anchor point
  to focus it before typing (an anchor element without bounds fails with
  `ANCHOR_NOT_FOUND`). Anchors are Semantic UI References: an optional ordered
  `candidates` chain resolves deterministically (first unique match wins) and
  the report records `resolvedBy { kind, confidence }` with `primary` or
  `fallback`; `visualMatch` is never performed by Core — when only it remains,
  resolution is `visualOnly` and fails closed with
  `RUNTIME_CAPABILITY_MISSING` (see `docs/semantic-anchor.md`).
- Annotated fallback is explicit and limited to `click` and `longClick`. Swipe
  without element bounds fails rather than guessing a region.
- `scrollTo` swipes a `container` up to `maxSwipes` until the anchor or
  `locator` resolves uniquely, then stops without acting. Exhaustion is
  `SCROLL_TARGET_NOT_FOUND`; so is a container subtree left unchanged by 2
  consecutive swipes (stalled at its edge, often a reversed direction).
  `direction` is the finger direction (`up` reveals content below).
  Annotated fallback is not allowed.
- `AdbPort` uses `appProcesses` for process discovery. Streaming Logcat starts
  with `-T 1`; generation observes and binds the App PID set before starting
  the per-step collector. `LogcatCollector` may also add later PIDs with
  `scopeToPids`, and completeness ignores drops from unrelated parsed PIDs.
  A retained line can prove a positive legacy `logcat` expectation despite
  other scoped drops; unique `logcatEvent` evidence remains fail-closed on any
  relevant drop in its window.
- Machine-readable `verify` and `generation` commands must emit exactly one JSON
  value to stdout. Progress and diagnostics go to stderr, and JSON `exitCode`
  must match the process exit code.
- Spawn child processes with argument arrays and `shell: false`.
- `dist/` is generated by `npm run build`. Brand PNGs are generated by
  `npm run brand:render` and should have no diff when current.

Adding an action crosses Journey and proposal schemas, recorder
prompt/preparation, generation validation and execution, `ActionExecutor`,
step/report schemas, docs, and tests. Adding an expectation crosses
`ExpectSchema`, generation validation, `ExpectationEvaluator`, failure/report
schemas, docs/examples, and tests. Extending `bridge` with External Flows
crosses `ExternalFlowSchema`, `ExternalFlowRegistry`, `ExternalFlowResolver`,
`StepRunner` external-step replay, `--external-flow` session binding,
`--include-external` listing, docs/examples, and tests.

## Tests

Tests mirror source layers under `test/domain`, `test/application`,
`test/adapters`, `test/cli`, and `test/tools`. Shared injected doubles live in `test/fakes`;
protocol samples live in `test/fixtures`. CLI process-contract tests exercise
the built CLI and fake external binaries, including the one-JSON stdout
contract. Checked-in Android demo contracts run without a device; actual Replay
and Generation device acceptance remain opt-in.

`test/parity/` is the Replay ↔ Generation safety net. `test/harness/`
provides `SimulatedDevice`, a deterministic state-machine `RuntimeBackend`
(`test/harness/demo-app.ts` models the demo app), and a runner that drives
the production composition root through `createProductionDependencies`'
`runtimeBackend` and `clock` options: only the device and time are simulated.
Each scenario must reach identical per-step verdicts in `verify` (under both
the recorded and the generated Replay policy) and in
`generation start → observe → step` (and finalize when it passes). A scenario
with a `record` script is also recorded through `taphound record` (scripted
prompt answers via the `recorderPrompt` option); the recorded Journey must
equal the scenario Journey without expectations and replay with every step
passing. Per-step
device-call counts are pinned in
`test/parity/__snapshots__/device-calls.json`; a change to that file is a
reviewed performance diff (update it with `npx vitest run test/parity -u`).
Add a scenario there before changing step execution semantics. A scenario
may declare `recordedReplay` or `generation` outcomes only for a documented,
intentional difference (recorded Journeys skip capability checks; Generation
rejects such proposals with `ACTION_UNSUPPORTED`).

Vitest excludes `**/.worktrees/**` to prevent duplicate discovery from nested
Git worktrees.
