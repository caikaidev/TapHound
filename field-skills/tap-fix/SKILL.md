---
name: tap-fix
description: >-
  复现并修复 Android Bug / Crash / ANR：用户说“复现修复”“修这个闪退”“排查问题并验证”时使用。Reproduce the reported failure before modifying code, compare identical RED/GREEN oracles, run existing unit tests and impacted behavioral regressions, and generate an auditable feedback ZIP. Not for standalone feature acceptance (use tap-check).
compatibility: Node.js 22+, Android project build tools; Mobile MCP/Appium/ADB for UI; ADB for Crash/Logcat as available; logic-only bugs may use unit tests without a device.
metadata:
  author: TapHound
  version: "3.6-copy-ready"
---

# tap-fix — reproduce, repair, preserve other behavior

When asked to diagnose/fix a specific Android bug or crash, **first prove the reported problem actually occurs**, then fix it, prove the exact original scenario no longer fails, and prove related usages B...N remain correct. Distinguish the reported failure from infrastructure errors or merely related UI problems. Never claim `FIXED` solely because an Agent changed code and a final script returned zero.

Read shared `../taphound-flash/references/v36-oracle-evidence.md`, `../taphound-flash/references/v35-reliability.md`, `../taphound-flash/references/feedback-workflow.md`, `../taphound-flash/references/impact-regression.md`, and `../taphound-flash/references/log-evidence.md`. This copy-ready Skill depends only on adjacent `../taphound-flash/scripts/`. Never require Journey/Contract/TapHound CLI. Every device attempt and unit attempt goes through `../taphound-flash/scripts/feedback.mjs`; the journal keeps all intermediate failure outputs and a ZIP regardless of eventual success.


## v3.6 automatic expectation check (no new user approval Gate)

Before RED, reconstruct the **reported** failure and its exact preconditions from the report, existing tests and the smallest relevant handler/ViewModel/callback chain. Before GREEN, confirm what user action actually commits a preview (never silently assume AI Summary auto-sends). Register `feedback.mjs oracle --dir FB --file <oracle-review.json>` using the shared template; a target expectation must reference the **bug-report** and may not be inferred from buggy source alone. For associated B...N preservation scenarios, include source-backed `scope: regression` expectations. Reuse one focused code investigation when a failure suggests an incorrect oracle; record `oracle-error`/`assertion-changed` with evidence, rerun target/regression and preserve all RED/GREEN oracle snapshots. Only ask the user if a genuine unresolved product decision or sensitive action requires it. A changed frozen RED/GREEN oracle never establishes `FIXED`, even when the revised check passes.

For an expected newly created result (not a pre-existing cached card), set `newSinceAction: true` on a positive UI `expect` and correlate the generated content/request to source-derived Logcat when available. Save terminal completion of asynchronous build/test jobs; `state:running` with exit_code:null is `INCONCLUSIVE`, not successful. Feedback ZIP prioritizes gates/timeline/attempts over huge Logcat files.

## Workflow

1. **Bind device and capture the report.** Choose one serial (honor user selection, ask if several devices and none specified). `feedback.mjs start --dir FB --skill tap-fix --task "..." --device SERIAL`. Record exact expected vs observed behavior, version, state/data prerequisites, Crash signature if supplied, and reported trigger. With logic-only bugs, an offline unit reproduction is acceptable; no device binding required. Don't touch another connected device.
2. **RED before changing code.** Use the original user's steps if available; otherwise infer a plausible route from real code, UI and crash stack, and verify it matches the actual failure. For Crash compare type, cause and first relevant app frame; for a visual overlap require both views simultaneously visible and geometric intersection. Run a meaningful failing unit test or a field-runner plan/custom script against **unfixed** code. Store the frozen oracle, screenshot/hierarchy and Logcat. Use `feedback.mjs event --type reproduction-confirmed --attempt NNN --evidence attempts/NNN/<specific-evidence>` only if evidence demonstrates the *same* issue. Exit 127, a permission failure, unrelated exception or partial symptom does not qualify as RED. Limit variants and document each attempt.
3. **If not reproduced:** do not make a speculative behavior fix or label it FIXED. Check whether existing logging wrappers/filters/Tag-prefix calculations obscure observation. If needed, add narrowly scoped opt-in debug instrumentation using the app's actual logging library, correlation IDs, state transitions, error categories and no secrets. Record code/diagnostic changes, produce a diagnostic build and instructions for testers, then `finish NOT_REPRODUCED` or `BLOCKED`. Await new tester evidence in a later case.
4. **Fix minimally; analyze impact.** Explain root cause from RED; modify the app, not the failing test oracle. Find changes to shared functions/state/resources, callers and all affected scenarios. Categorize desired changed behavior and existing required behavior to preserve. Look for preexisting relevant JUnit/Robolectric/MockK/Compose/Espresso/integration tests. Capture an impact plan with `target`, `scenarios`, `existingTests`, `risks` and register it with `feedback.mjs impact`. Unverified high-risk shared consumers must be listed as blocking risks rather than silently excluded.
5. **GREEN with the identical original test.** Build/install the fixed APK on the *same* serial, save identity and evidence, run **the same frozen original RED oracle**. Check the specific reported outcome no longer occurs and independently observe actual correct behavior, including real source-derived positive downstream logs when the behavior requires it. A new test method or weakened expectation does not establish fixed RED/GREEN; the journal compares test file hashes and must reject changed oracles. Record target PASS on the GREEN attempt, not on the RED or a later unrelated regression.
6. **Execute all related EXISTING tests.** Discover tests for modified symbols **and other users** of them. Run the required tests on the final source, preserving actual JUnit XML or Node TAP counts; zero tests, all skipped, cached results or tests newly disabled cannot satisfy the gate. If a preexisting failure exists, produce real before-change/CI evidence rather than a guess. Refuse silently editing old assertions just to greenlight.
7. **Run separate related regressions.** Verify every required affected B...N: alternate caller, state reset, exit/return, boundary and durable state behavior as appropriate. Use an independent device plan with `scenarioIds`, `scenarioChecks` mapped to independent actual assertion steps or an explicit custom `scenario-results.json`. The regression Attempt cannot simply be the same A-only target Attempt. If a regression fails, fix the issue and rerun target GREEN, related original tests, and all necessary regressions *after the last source edit*.
8. **Finalize.** Record all three gates (`target`, `existing-tests`, `regression`) with evidence. `finish FIXED` requires confirmed RED, identical target GREEN, all relevant original tests passed, B...N regression coverage, and no blocking unverified risk. A failure of B or C means `FAILED`, not FIXED. Missing evidence is `INCONCLUSIVE` or `BLOCKED`, not a false green. Always return the local `feedback.zip` path to the user.

## Command pattern

```bash
JOURNAL="<absolute skill-root>/taphound-flash/scripts/feedback.mjs"
FB=".taphound/feedback/<unique-id>"
node "$JOURNAL" start --dir "$FB" --skill tap-fix --task "<reported issue>" --device SERIAL
node "$JOURNAL" oracle --dir "$FB" --file .taphound/build/field-tests/<case>/oracle-review.json # report-based target and preservation expectations
# RED: run before app edits, e.g. custom device script:
node "$JOURNAL" exec --dir "$FB" --device SERIAL --package com.example.app --apk path/to/pre-fix.apk --oracle-file ./verify_repro.sh -- env SERIAL=SERIAL bash ./verify_repro.sh
node "$JOURNAL" event --dir "$FB" --type reproduction-confirmed --attempt 001 --evidence attempts/001/stdout.txt --summary "Actual reported failure observed (not just test exit 1)"
# After app fix, analyze shared effects and register impact-plan.json:
node "$JOURNAL" impact --dir "$FB" --file .taphound/build/field-tests/<case>/impact-plan.json
# GREEN: identical frozen test script after building/installing fixed APK:
node "$JOURNAL" exec --dir "$FB" --device SERIAL --package com.example.app --apk path/to/post-fix.apk --oracle-file ./verify_repro.sh -- env SERIAL=SERIAL bash ./verify_repro.sh
node "$JOURNAL" gate --dir "$FB" --gate target --status PASS --attempt 002 --evidence attempts/002/stdout.txt --summary "Original failure gone; original intended outcome seen"
# Run old tests via exec and record existing-tests gate with real test report.
# Run distinct B...N regressions via run/exec and record regression gate.
node "$JOURNAL" finish --dir "$FB" --status FIXED --summary "RED→GREEN, existing tests and impacted regressions all verified"
```

The example is not a fixed set of steps; use task-specific scripts and files. The runner tries **Mobile MCP → Appium → ADB for UI on the same selected device**; ADB auxiliary Logcat/Crash and APK checks remain allowed. A failed business assertion must not trigger switching to a different backend/device. `feedback.mjs exec --device SERIAL` uses a best-effort ADB PATH guard for custom scripts; it cannot sandbox absolute binaries or Gradle's internal multi-device routing. Do not use an unscoped Gradle `connectedAndroidTest` task; run instrumentation with a verified explicitly selected device. Missing device identity/isolation must block claims about actual device validation. Source-specific logs, positive app result, and immutable oracles are expected when they are meaningful. Any test changes must be justified with versioned evidence, never disguised as identical reproduction.

After success or failure, tell the user `FB/feedback.zip` and the per-gate results. Redact user data, credentials, personal chats, APK paths, raw Logcat and screenshots before upload. No claim of exhaustive bug freedom.
