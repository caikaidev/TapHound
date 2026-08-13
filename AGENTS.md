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

The CLI exposes `doctor`, `record`, `verify`, `project`, `context`,
`generation`, and `init`. Keep external tools and filesystem effects behind
ports so application tests can inject fakes.

### Verification Flow

`VerifyRuntime` checks installation, starts Logcat, force-stops and cold-launches
the app, waits for process and Activity readiness, and runs Journey steps through
`StepRunner`.

Each step checks the before Activity, resolves a deterministic locator, applies
an explicitly configured annotated-label fallback only when eligible, executes
the ADB action, waits for layout stability, checks process and after Activity,
and evaluates any explicit expectation. Replay stops at the first primary
failure. Final screenshot and Logcat collection still run; collection failures
become secondary errors instead of replacing the primary failure.
`ReportWriter` and `ArtifactStore` publish each completed run atomically.

### Recorder Flow

`RecorderService` checks installation, resets and launches the app, reads each
layout, prompts for an action and deterministic target, executes it through the
shared interaction and idle abstractions, and captures before/after Activities.
Only successful steps enter the Journey. Cancellation or failure does not write
a partial Journey, and the recorder does not invent business `expect`
assertions.

### Project Context and Generation Flow

`ProjectDescriber` emits stable package and launch facts. `ContextValidator`
validates a source-derived Project Context, including project identity and
evidence freshness.

Generation is a revisioned, evidence-backed state machine:

1. `GenerationStarter` validates and hashes the project, config, and context,
   binds one device and interaction policy, and creates an authoritative session.
2. `RuntimeObserver` captures layout and screenshot evidence, hashes the
   snapshot, and atomically advances the session revision.
3. `GenerationStepExecutor` accepts only proposals bound to the current session
   revision and snapshot. It re-observes freshness, applies risk confirmation,
   executes deterministically, records evidence, and commits successful steps.
4. `GenerationFinalizer` revalidates all bindings, resets the app, replays the
   complete candidate Journey through `VerifyRuntime`, and publishes the Journey,
   metadata, report, receipt, and manifest only after exact verification passes.

`FileSystemGenerationSessionStore` is the authoritative persistence boundary for
generation state and immutable evidence. Its revision checks, locking, atomic
renames, path validation, recovery state, and core-identity invariants are part
of the protocol; do not bypass them with direct filesystem writes.

## Protocol and Implementation Constraints

- The project uses ESM with NodeNext resolution. TypeScript source imports use
  `.js` suffixes because those paths must work in emitted JavaScript.
- TypeScript is strict, with exact optional properties and unchecked index
  access. ESLint uses strict type-aware rules and requires explicit return types.
- Protocol schemas use `z.strictObject`; unknown fields are intentionally
  rejected. Coordinate schema, inferred types, runtime behavior, docs/examples,
  fixtures, and tests whenever a protocol changes.
- Config has no build or artifact input because TapHound does not compile.
  Report `schemaVersion` is `2`; installation failure is `APP_NOT_INSTALLED`
  with exit code 3.
- Locator priority is fixed: `resourceId`, then `text`, then
  `contentDescription`. Missing or ambiguous matches fail rather than selecting
  heuristically.
- Annotated fallback is explicit and limited to `click` and `longClick`. Swipe
  without element bounds fails rather than guessing a region.
- `scrollTo` swipes a `container` up to `maxSwipes` until `locator` resolves
  uniquely, then stops without acting. Exhaustion is
  `SCROLL_TARGET_NOT_FOUND`; annotated fallback is not allowed.
- `AdbPort` uses `appProcesses` for process discovery. `LogcatCollector` scopes
  to a PID set with `scopeToPids`.
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
schemas, docs/examples, and tests.

## Tests

Tests mirror source layers under `test/domain`, `test/application`,
`test/adapters`, and `test/cli`. Shared injected doubles live in `test/fakes`;
protocol samples live in `test/fixtures`. CLI process-contract tests exercise
the built CLI and fake external binaries, including the one-JSON stdout
contract. Checked-in Android demo contracts run without a device; actual Replay
and Generation device acceptance remain opt-in.

Vitest excludes `**/.worktrees/**` to prevent duplicate discovery from nested
Git worktrees.
