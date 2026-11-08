# v3.5 Shared change-impact and regression policy

Applies identically to `tap-check` and `tap-fix`. This is a lightweight *Agent-generated* analysis; it is not static-code-analysis proof or an exhaustive call graph. Read the real application's source and tests, not generic examples. The objective is to establish both that the requested change works **and** that other known consumers of modified behavior continue to work.

## 1. Discover actual impact before the final gate

Start with the user's requested behavior and the actual change: `git diff`, staged diff, untracked source files, changed methods, injected dependencies, shared resources, public APIs and data writes. Follow direct/indirect callers and consumers, state flows (StateFlow/LiveData/Compose state), navigation, callbacks, event buses, DI, jobs, XML/Compose bindings, persistent state and side effects. A changed shared function used by A/B/C demands distinct checks for B/C when they are affected. Do not claim that search results are exhaustive; record dynamic/reflective and uninspected paths as risks.

For **intentional new behavior**, mark affected scenarios `intent: "changed"`; for behavior expected to remain, mark them `intent: "preserve"`. A known wrong behavior must not become the preservation baseline. Before changing an old expectation, verify that the user request authorizes it. Prefer existing test assertions or documented requirements; use before-change runtime observations only as evidence, not unquestioned truth.

## 2. Find existing tests first

Search source test trees and Gradle configuration for JUnit, Robolectric, Mockito/MockK, instrumentation, Compose/Espresso, repository/view-model, connected instrumented tests and other frameworks. Find tests for the edited symbol **and** callers/consumers, not only filename matches. Run all **relevant existing tests** (include known related modules), not just a new test that is easy to make pass. Expand scope when impact is broad or uncertain; prioritize high-risk scenarios, boundaries and state transitions. The objective is risk-based coverage, not a fixed test count.

Record each relevant existing test as `existingTests[]` with unique `id`, exact command, and `required:true` when it must pass. Execute via `feedback.mjs exec --oracle-file <test source> -- <test command>`. Prefer `--rerun-tasks` for Gradle when verifying a modified implementation. Save real JUnit XML or Node TAP reports. A passing shell exit code or "BUILD SUCCESSFUL" is **not** a test-execution report; all-skipped, zero-test, failed and stale reports cannot satisfy the Gate. Existing known baseline failures must be recorded and differentiated with actual pre-change/CI evidence; never silently reclassify a new failure as preexisting. After registering impact, run `feedback.mjs discover --dir "$FB" --project "$PWD"`. It writes an auditable `tests/discovery.json` with same-module and cross-module symbol candidates. If potential related tests exist, Existing Tests N/A is forbidden; inspect and run them or report uncertainty. Only use `NOT_APPLICABLE` with a complete source-aware scan, no candidates and `--evidence tests/discovery.json`. This scan is heuristic; expand search through DI, Gradle dependencies and consumers. Add missing behavior tests if necessary.

When a test expectation legitimately must change with the approved requirement, save the before/after test diff and rationale; do not edit tests merely to make them pass. When a regression fails and the Agent fixes it, rerun **target**, **existing tests** and **regressions** after the final source change.

## 3. Create versioned impact plan

Save `.taphound/build/field-tests/<case>/impact-plan.json` like:

```json
{
  "version": 1,
  "changeIntent": "Hide the pinned banner during multi-select while retaining ordinary banner behavior",
  "target": { "id": "A", "expected": "With multi-select active the banner is absent; exiting restores it" },
  "changedSymbols": [{ "symbol": "updateBannerVisibility", "file": "app/.../ChatFragment.kt", "reason": "shared visibility state" }],
  "scenarios": [
    { "id": "B", "description": "Pinned banner visible during ordinary chat", "intent": "preserve", "risk": "high", "required": true },
    { "id": "C", "description": "Switch chats and render each chat's banner", "intent": "preserve", "risk": "high", "required": true }
  ],
  "existingTests": [
    { "id": "banner-unit", "command": "./gradlew :app:testDebugUnitTest --rerun-tasks", "required": true }
  ],
  "risks": []
}
```

IDs: letters then letters/digits/underscores/hyphens; no duplicate IDs. Required scenarios must get executed; a risk that could invalidate acceptance and cannot be tested must appear as `{"id":"...","severity":"high","reason":"...","blocking":true}`. Optional risks should also be disclosed in final summary.

`node "$JOURNAL" impact --dir "$FB" --file <impact-plan.json>` snapshots immutable versions and activates the newest. Any changed code/impact plan invalidates earlier successful gates. Save a meaningful discovery note (why other scenarios were selected and what was searched) in timeline or attach a discovery file. An N/A Gate must cite a real saved evidence file, not merely an assertion.

## 4. Execute separately evidenced gates

- `target`: an independent passing Attempt with the actual expected outcome and relevant log chain (or documented independent logic evidence).
- `existing-tests`: the relevant original tests executed on the final source state, with actual test report. `--test-report` may be used repeatedly for separate JUnit XML/Node TAP report files. The files are snapshotted in feedback ZIP. Zero tests or all skipped **never** pass.
- `regression`: each required affected scenario is explicitly covered. For a Field Runner JSON plan, include `"scenarioIds":["B","C"]` and `"scenarioChecks":[{"id":"B","assertionSteps":[1]},{"id":"C","assertionSteps":[3]}]` (matching real `expect` steps) in the *regression* plan and use a separate Attempt from target A, with real assertions checking B/C. For custom runners, write `attempts/NNN/evidence/scenario-results.json` shaped `{"version":2,"scenarios":[{"id":"B","status":"passed","assertions":[{"id":"chat-visible","operator":"equals","expected":true,"actual":true,"evidence":"attempts/003/evidence/ui-observed.json"}]}]}` and provide this file as `--evidence`; the actual test command must exercise each declared scenario. A mere claimed scenario ID without behavior evidence is insufficient.

```bash
node "$JOURNAL" gate --dir "$FB" --gate target --status PASS --attempt 001 --evidence attempts/001/evidence/field-result.json --summary "Target assertions and causal logs matched"
node "$JOURNAL" gate --dir "$FB" --gate existing-tests --status PASS --attempt 002 --test banner-unit --test-report app/build/test-results/testDebugUnitTest/TEST-BannerTest.xml --evidence attempts/002/stdout.txt --summary "Existing relevant tests passed"
node "$JOURNAL" gate --dir "$FB" --gate regression --status PASS --attempt 003 --scenario B --scenario C --evidence attempts/003/evidence/field-result.json --summary "Other consumers remained correct"
```

For `NOT_APPLICABLE` when **no** relevant tests or scenarios exist in the impact inventory, explicitly record the inventory evidence, then:

```bash
node "$JOURNAL" gate --dir "$FB" --gate existing-tests --status NOT_APPLICABLE --evidence tests/discovery.json --summary "No related pre-existing tests after source and test discovery"
```

`PASS/FIXED` requires the latest impact plan and all three current gates passing (or justified N/A), no blocking risks, no stale code changes since any gate, and for `FIXED` a confirmed RED → GREEN **of the same oracle**. A regression failure is never hidden by the target passing. Final result `FAIL/FAILED`, `BLOCKED`, or `INCONCLUSIVE` as appropriate; include unverified/nonblocking risks. Passing selected tests cannot prove there are no unknown bugs.

## 5. Device binding and provider priority

Bind a single serial once: `feedback.mjs start ... --device SERIAL` (or select one uniquely available device in the first `run`). Every UI operation, APK install, screenshot and Logcat must use the **same** serial. Use `--device SERIAL` consistently for Runner calls; never switch to another serial if target is missing. `auto` means **Mobile MCP → Appium → ADB** *on this device*. Mobile MCP is the preferred **UI driver**, while `adb -s SERIAL` may supply Activity, Crash, Logcat, process and package evidence. An unavailable/ambiguous identity is BLOCKED, not permission to choose someone else's device.

`feedback.mjs exec --device SERIAL` injects the bound serial into `SERIAL`, `ANDROID_SERIAL` and `TAPHOUND_DEVICE_SERIAL`, and PATH-wraps ordinary ADB CLI calls to reject a different `-s`. This is best-effort isolation, **not a security sandbox**: custom executables using absolute adb paths, Gradle's internal device routing, or external processes can bypass PATH. For Gradle connectedAndroidTest, the journal refuses unsafely unscoped invocations: use explicit `adb -s SERIAL shell am instrument ...` after compiling the test APK, or a verified device-scoped tool. If isolation cannot be established, record the gap as BLOCKED/INCONCLUSIVE. Avoid modifying other connected devices or running tests on them.

**Evidence boundary:** Version 1 custom scenario reports with only a `passed` status or descriptive strings no longer satisfy a PASS regression gate. Version 2 requires primitive measured expected/actual values and a separately attached observation file for every assertion. Supply both `scenario-results.json` and each referenced observation via `--evidence`. These values originate in the custom script, so they are **externally reported checks**, not independently measured UI assertions by TapHound.
