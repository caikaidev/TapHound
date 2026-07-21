# TapHound Repository Guide

TapHound is an ESM TypeScript/Node.js CLI for deterministic Android journey
recording and verification. It uses its own strict JSON Journey protocol, not
Android CLI's Journey format, and does not use AI or visual guessing during
replay.

## Toolchain and Commands

- `package.json` declares Node.js 22 or newer. Current ESLint dependencies
  require Node 22.13+ or 24+; avoid Node 23. Install locked dependencies with
  `npm ci`.
- Run all tests: `npm test`
- Run one test file: `npm test -- test/domain/journey.test.ts`
- Run one named test:
  `npm test -- test/domain/journey.test.ts -t "parses a valid TapHound Journey fixture"`
- Run coverage: `npm run coverage`
- Type-check without emitting: `npm run typecheck`
- Lint: `npm run lint`
- Build `src` plus declarations into generated `dist/`: `npm run build`
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

Real-device acceptance is separate and opt-in. It requires Android SDK, ADB,
Android CLI, an executable project Gradle wrapper, an online device, and a
completed build:

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:device
```

See `docs/local-testing.md` for tarball and Android demo validation. Do not treat
the normal test suite as evidence that real-device acceptance passed.

## Architecture

The code follows ports and adapters:

- `src/domain/` owns strict Zod schemas and domain types for configuration,
  layouts, locators, journeys, failures, and reports. These schemas are the
  protocol contracts.
- `src/ports/` defines interfaces for ADB, Android CLI, Gradle, processes,
  clocks, prompts, artifact storage, and journey writing.
- `src/adapters/` implements those ports using child processes, the filesystem,
  the system clock, and Inquirer.
- `src/application/` contains deterministic use cases: environment diagnosis,
  recording, locator and fallback resolution, action execution, idle waiting,
  expectation evaluation, Logcat collection, verification orchestration, and
  report publication.
- `src/cli/` contains Commander commands and the composition root.
  `createProductionDependencies` in `src/cli/dependencies.ts` wires production
  adapters into `DoctorService`, `RecorderService`, and `VerifyRuntime`.

`src/cli/main.ts` is the executable entry point. The CLI exposes `doctor`,
`record`, and `verify`; commands validate input before calling application
services. Keep external tools behind ports so application tests can inject
fakes.

### Verification Flow

`VerifyRuntime` builds the Android project, reads APK metadata, starts Logcat,
launches the app, checks initial process/activity/layout readiness, and then
runs Journey steps sequentially through `StepRunner`.

Each step checks the before Activity, resolves a deterministic locator, applies
an explicitly configured annotated-label fallback if eligible, executes the ADB
action, waits for layout stability, checks process and after Activity, and
evaluates any explicit expectation. Replay stops at the first primary failure.
Final screenshot and Logcat collection still run, and collection failures are
recorded as secondary errors rather than replacing the primary failure.
`ReportWriter` and `ArtifactStore` publish the completed run atomically.

### Recorder Flow

`RecorderService` builds and launches the app, reads each layout, prompts for an
action and deterministic target, executes the action through the shared action
and idle abstractions, and captures before/after Activities. Only successful
steps enter the Journey. Cancelled or failed recording does not write a partial
Journey, and the recorder does not invent business `expect` assertions.

## Protocol and Implementation Constraints

- The project uses ESM with NodeNext resolution. TypeScript source imports use
  `.js` suffixes because those paths must work in emitted JavaScript.
- TypeScript is strict, including exact optional properties and unchecked index
  access. ESLint uses strict type-aware rules and requires explicit function
  return types.
- Journey, config, and report schemas use `z.strictObject`; unknown fields are
  intentionally rejected. Coordinate schema, inferred types, runtime behavior,
  docs/examples, and tests when changing a protocol.
- Locator priority is fixed: `resourceId`, then `text`, then
  `contentDescription`. Missing or ambiguous matches fail instead of selecting
  heuristically.
- Annotated fallback is explicit and limited to `click` and `longClick`.
  Swipe without element bounds fails instead of guessing a region.
- `scrollTo` scrolls a `container` locator up to `maxSwipes` times until its
  target `locator` resolves uniquely, then stops without acting. Exhausting the
  bound fails with `SCROLL_TARGET_NOT_FOUND`. No annotated-label fallback.
- `verify --json` must write exactly one JSON value to stdout. Progress and
  diagnostics belong on stderr, and the JSON `exitCode` must match the process
  exit code.
- Child processes are spawned with argument arrays and `shell: false`.
- `dist/` is generated by the build. Brand PNGs are generated by
  `npm run brand:render` and should produce no diff when current.

Adding an action crosses `JourneyStepSchema`, recorder prompt/preparation,
`ActionExecutor`, step/report schemas, and tests. Adding an expectation crosses
`ExpectSchema`, `ExpectationEvaluator`, failure/report schemas, documentation
examples, and tests.

## Tests

Tests mirror source layers under `test/domain`, `test/application`,
`test/adapters`, and `test/cli`. Shared injected doubles live in `test/fakes`;
protocol samples live in `test/fixtures`. CLI process-contract tests exercise
the built CLI with fake external binaries. The checked-in Android demo contract
is tested without a device, while actual device execution remains opt-in.

Vitest excludes `**/.worktrees/**` to avoid duplicate discovery from nested Git
worktrees.
