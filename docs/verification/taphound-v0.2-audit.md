# TapHound v0.2 Completion Audit

- Audit date: 2026-07-19
- Reference: [Original approved design](../archive/%61pr-v0.2/2026-07-19-%61pr-v0.2-design.md) and [original implementation plan](../archive/%61pr-v0.2/2026-07-19-%61pr-v0.2-implementation.md)
- Brand note: APR is the internal codename TapHound used during its unreleased phase.
- Audit conclusion: All nine v0.2 completion criteria have implementation and automation evidence; there is no online Android device on this machine, so real-device end-to-end acceptance was not run and is not claimed as passed.

## Completion Criteria Evidence

| # | Approved completion criterion | Implementation evidence | Verification evidence | Conclusion |
|---|---|---|---|---|
| 1 | TapHound interactive Recorder produces a Journey containing Action, Locator, and Activity Checkpoint | [`recorder-service.ts`](../../src/application/recorder/recorder-service.ts), [`locator-selector.ts`](../../src/application/recorder/locator-selector.ts), [`inquirer-recorder-prompt.ts`](../../src/adapters/prompt/inquirer-recorder-prompt.ts) | [`recorder-service.test.ts`](../../test/application/recorder/recorder-service.test.ts) covers build/launch, action execution, before/after Activity, selecting the correct target under duplicate Android CLI keys, saving only successful steps, atomic Finish write, and Cancel; [`locator-selector.test.ts`](../../test/application/recorder/locator-selector.test.ts) covers Locator uniqueness and priority | Proven |
| 2 | Explicitly supplement and validate Activity, Element, and Logcat assertions | [`journey.ts`](../../src/domain/journey.ts) defines three explicit Expect types; [`expectation-evaluator.ts`](../../src/application/assertion/expectation-evaluator.ts) performs deterministic evaluation | [`journey.test.ts`](../../test/domain/journey.test.ts) covers the three schemas and illegal regex; [`expectation-evaluator.test.ts`](../../test/application/assertion/expectation-evaluator.test.ts) covers success, timeout, cancel, and Logcat window | Proven |
| 3 | Automatically execute Gradle Build and Android CLI Run | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts), [`gradle-adapter.ts`](../../src/adapters/gradle/gradle-adapter.ts), [`android-cli-adapter.ts`](../../src/adapters/android-cli/android-cli-adapter.ts) | [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) verifies the full phase order, metadata Package conflict, and failure boundaries; [`gradle-adapter.test.ts`](../../test/adapters/gradle/gradle-adapter.test.ts) and [`android-cli-adapter.test.ts`](../../test/adapters/android-cli/android-cli-adapter.test.ts) verify argument arrays, APK, Activity, and device serial | Proven |
| 4 | Deterministically execute all first-phase Actions via ADB | [`action-executor.ts`](../../src/application/interaction/action-executor.ts) and [`adb-adapter.ts`](../../src/adapters/adb/adb-adapter.ts) implement click, longClick, inputText, swipe, back; wait sends no ADB operation | [`action-executor.test.ts`](../../test/application/interaction/action-executor.test.ts) covers all Actions; [`adb-adapter.test.ts`](../../test/adapters/adb/adb-adapter.test.ts) verifies exact parameters and device scoping for tap/swipe/keyevent/text | Proven |
| 5 | Stable waiting based on Layout Diff, no fixed sleep | [`idle-waiter.ts`](../../src/application/wait/idle-waiter.ts) uses an injected Clock; stability requires consecutive empty Diffs and retains the last Diff | [`idle-waiter.test.ts`](../../test/application/wait/idle-waiter.test.ts) uses a Fake Clock to cover stability, reset, timeout, cancel, and device pass-through, with no real waiting | Proven |
| 6 | Slice and match Logcat per step | [`logcat-collector.ts`](../../src/application/collector/logcat-collector.ts) waits for streaming process startup to stabilize, records monotonic receive timestamps and slices; [`step-runner.ts`](../../src/application/runtime/step-runner.ts) writes step logs; Expect evaluator matches tag/level/pattern | [`logcat-collector.test.ts`](../../test/application/collector/logcat-collector.test.ts) covers async startup failure, `[T0,T1]` slicing with boundaries, and PID scope; [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) proves a startup-phase exit becomes the primary failure before the Run; StepRunner and Expect tests cover step-level consumption | Proven |
| 7 | Output Screenshot, raw logs, step logs, and layered report | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts), [`report-writer.ts`](../../src/application/report/report-writer.ts), [`artifact-store.ts`](../../src/adapters/filesystem/artifact-store.ts) | [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) covers final collection, primary/secondary failures, and intentional SIGTERM stopping Logcat; [`report-writer.test.ts`](../../test/application/report/report-writer.test.ts) and [`artifact-store.test.ts`](../../test/adapters/filesystem/artifact-store.test.ts) cover the report tree and atomic publish; [`report.test.ts`](../../test/domain/report.test.ts) validates the layered schema and fallback evidence | Proven |
| 8 | `taphound verify --json` can be reliably invoked by any external Agent CLI | [`verify.ts`](../../src/cli/commands/verify.ts) and [`output.ts`](../../src/cli/output.ts) provide machine output and fixed exit codes; [`agent-integration.md`](../agent-integration.md) documents the invocation contract | [`verify-json.test.ts`](../../test/cli/verify-json.test.ts) validates the JSON contract under dependency injection; [`verify-process.test.ts`](../../test/cli/verify-process.test.ts) launches a real OS subprocess of the built CLI, validating exit codes 0–4, a single JSON value on stdout, stderr isolation, and actual report publication; [`commands.test.ts`](../../test/cli/commands.test.ts) covers parameter coverage and mapping | Proven |
| 9 | Execution and evaluation do not depend on AI | Domain, Runtime, and Adapters are explicit state machines, schemas, Locators, ADB, Layout Diff, and string/regex evaluation; [`package.json`](../../package.json) contains only Commander, Inquirer, and Zod runtime dependencies | `rg -ni "openai|anthropic|claude|\\bllm\\b|model inference|vision" src package.json package-lock.json` returns no matches; tests rejecting the official/natural-language Journey format are in [`journey.test.ts`](../../test/domain/journey.test.ts) | Proven |

## Key Constraint Audit

| Constraint | Evidence | Conclusion |
|---|---|---|
| TapHound Journey is fully self-built; it does not call or remain compatible with the official Journey | Strict [`JourneySchema`](../../src/domain/journey.ts) and its tests rejecting extra/natural-language formats; documentation in [`journey-schema.md`](../journey-schema.md) explicitly distinguishes the two | Proven |
| `run.packageName` is required, and Activity normalization does not guess the Package | [`config.ts`](../../src/domain/config.ts), [`activity.ts`](../../src/domain/activity.ts), and the corresponding [`config.test.ts`](../../test/domain/config.test.ts), [`activity.test.ts`](../../test/domain/activity.test.ts) | Proven |
| Fails before the Run when the configured Package conflicts with the Android project metadata | [`describe-parser.ts`](../../src/adapters/android-cli/describe-parser.ts) extracts the unique `applicationId` by target/variant; [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts) compares before launch; corresponding Parser and Runtime tests cover consistent, missing, and conflicting cases | Proven; review fix |
| Layout parsing is consistent with the installed Android CLI 1.0 serialization protocol | [`layout-output.json`](../../test/fixtures/android-cli/layout-output.json) preserves the flat array, duplicate `key`, `interactions`, `center`, optional `bounds`, `state`, and off-screen real shape; the Parser uses `key:path` as the unique internal ID, and tests cover the real protocol, duplicate-key Recorder selection, and the legacy format | Proven; review fix |
| click/longClick falls back only when the Journey explicitly records `annotatedLabel` | [`journey.ts`](../../src/domain/journey.ts), [`fallback-resolver.ts`](../../src/application/interaction/fallback-resolver.ts), and [`fallback-resolver.test.ts`](../../test/application/interaction/fallback-resolver.test.ts) | Proven |
| Activity is verified before and after each step; failure aborts immediately | [`step-runner.ts`](../../src/application/runtime/step-runner.ts), [`step-runner.test.ts`](../../test/application/runtime/step-runner.test.ts), [`verify-runtime.test.ts`](../../test/application/runtime/verify-runtime.test.ts) | Proven |
| All device-related Android CLI commands use the same explicit device serial | [`android-cli.ts`](../../src/ports/android-cli.ts), Adapter, Recorder, Idle, Expect, and Runtime contract tests | Proven; audit fix |
| doctor uses real capability probing; it does not call a nonexistent `android doctor` | [`doctor-service.ts`](../../src/application/doctor/doctor-service.ts) selects a device first, then probes permissions via a screenshot on that device; [`doctor-service.test.ts`](../../test/application/doctor/doctor-service.test.ts) covers no-device `notRun` and probe failure | Proven; audit fix |
| External commands do not go through the local shell; bounded timeouts and cancellation are supported | [`node-process-runner.ts`](../../src/adapters/process/node-process-runner.ts) directly `spawn`s the executable/args, provides a finite default timeout for non-streaming commands, and exposes a streaming startup stability result; the CLI converts SIGINT/SIGTERM into an AbortSignal; Layout/ADB polling passes the remaining deadline | Process runner, Logcat, Idle, Expect, Runtime, and CLI tests cover argument fidelity, default/explicit timeouts, early streaming-startup exit, AbortSignal, and signal propagation | Proven; review fix |
| ADB text input escapes per remote shell single-quote rules | [`adb-adapter.ts`](../../src/adapters/adb/adb-adapter.ts) handles spaces, metacharacters, single quotes, and `%s` segmentation; Adapter tests cover malicious shell characters and Unicode arguments | Proven; review fix |
| The primary failure is not overwritten by auxiliary collection errors | [`verify-runtime.ts`](../../src/application/runtime/verify-runtime.ts) distinguishes primary failure from secondary errors; Runtime tests cover best-effort screenshot/Logcat and graceful SIGTERM stop | Proven; audit fix |
| Journey and report are published atomically | [`journey-writer.ts`](../../src/adapters/filesystem/journey-writer.ts), Artifact store, and their respective tests | Proven |
| No Skill/SubAgent integration in this phase | Only the stable CLI contract described in [`agent-integration.md`](../agent-integration.md) is provided; the source has no Skill/SubAgent runtime entry point | Within scope |

## Local Quality Gate

Executed in an isolated worktree on Node.js 24.3.0:

| Command | Result |
|---|---|
| `npm ci` | Passed; installed 206 packages per `package-lock.json` |
| `npm test` | Passed; 35 test files, 211 tests |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; generated `dist/cli/main.js` |
| `node dist/cli/main.js --help` | Passed; lists `doctor`, `record`, `verify` |

The example project includes an executable Gradle 8.9 Wrapper. The fixture contract test also verifies the Wrapper JAR SHA-256 is `498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17` and the distribution SHA-256 is `d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab`.

## Environment and Real-Device Acceptance

Executed:

```text
node dist/cli/main.js doctor --project examples/taphound-android-demo --json
```

Actual result:

```json
{"status":"failed","checks":[{"name":"node","status":"passed","version":"24.3.0"},{"name":"adb","status":"passed","version":"Android Debug Bridge version 1.0.41"},{"name":"android","status":"passed","version":"1.0.15857036"},{"name":"gradle","status":"passed"},{"name":"permissions","status":"notRun","message":"Permission probe requires an online selected device"},{"name":"device","status":"failed","message":"Expected exactly one online device, found 0"}],"failureCode":"DEVICE_UNAVAILABLE"}
```

Therefore:

- Node, ADB, Android CLI, and the example Gradle Wrapper probes passed.
- The number of online devices is 0; the device permission probe is marked `notRun` per contract.
- `TAPHOUND_ACCEPTANCE_DEVICE=1` was not set, and `npm run acceptance:device` was not run; no real-device report path is available to attach.
- [`fixture-contract.test.ts`](../../test/acceptance/fixture-contract.test.ts) proves the example Package, Activity, Locator, Logcat, Wrapper, and acceptance script are statically consistent, but it does not substitute for a real-device end-to-end result.

Real-device acceptance is the environment gate from design 12.5 that runs only "when Android CLI and a device are available." The only missing external precondition here is an online Emulator or USB Device. The code, fixtures, and explicit opt-in runner are ready; this audit does not misreport that external result as passed.
