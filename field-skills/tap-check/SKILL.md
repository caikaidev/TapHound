---
name: tap-check
description: >-
  验收 Android 新需求或代码调整：用户说“验收这次修改”“检查刚做的功能”“验证需求是否完成”时使用。Verify post-development Android changes, protect related pre-existing unit tests and impacted scenarios, validate UI plus source-derived logs, and generate an auditable feedback ZIP. Not for general review or bug reproduction-first fixes (use tap-fix).
compatibility: Node.js 22+, Android project build tools, optional mobile-mcp/Appium, ADB for source-derived Logcat and APK evidence; no TapHound CLI required.
metadata:
  author: TapHound
  version: "3.6-copy-ready"
---

# tap-check — acceptance AND behavior preservation

Use when the user asks to **verify a completed Android change**. The goal is not just to pass the changed scenario A, but to identify other scenarios B...N using the modified code and check that their previously intended behavior still works. Do not trigger for code review, brainstorming or before implementation. For reproduce-first fixes, use sibling `tap-fix`.

This directory is copy-ready only alongside `../taphound-flash/`. Resolve shared scripts relative to the Skill's own directory, not the Android repo. Read `../taphound-flash/references/v36-oracle-evidence.md`, `../taphound-flash/references/v35-reliability.md` and `../taphound-flash/references/impact-regression.md`, `../taphound-flash/references/feedback-workflow.md`, and `../taphound-flash/references/log-evidence.md` before execution. All tests MUST use `../taphound-flash/scripts/feedback.mjs` so every failure, retry and source/test mutation is retained. A successful Agent message without this feedback journal is not a completed tap-check.

## Workflow

1. **Identify the request and bind the device.** Read the available current user requirements and development conversation; do not invent unavailable context. Inspect tracked, staged and *untracked* source changes. If the user specified a serial, bind it with `feedback.mjs start --device SERIAL` and use it for all device operations. If multiple devices exist and no serial was chosen, ask for one before touching a device. Never operate another device. For unit-only checks no device is needed.
2. **Analyze impact, not just diff files.** Find changed symbols, direct/indirect call sites, shared ViewModel/Repository state, Compose/LiveData/StateFlow consumers, resource users, asynchronous callbacks and persistence effects. Explicitly separate intentionally changed behavior from previously correct behavior that MUST be preserved. Analyze pre-change evidence if needed, but do not assume an existing bug is a desirable baseline. Mark high-risk unreachable dependencies as blocking risks. Create a project-specific impact plan (see shared reference and template).
3. **Discover all relevant existing tests first.** Search tests related to edited functions and their consumers, not just newly added tests. Record each required pre-existing unit/integration test in `existingTests[]`, with its exact invocation. Run those tests against the final code and keep actual JUnit XML/Node TAP reports. A 0 exit code, cached Gradle task, skipped tests or "BUILD SUCCESSFUL" without executed tests does NOT prove existing tests passed. After recording impact, run `feedback.mjs discover --dir FB --project PROJECT` and review `tests/discovery.json`. A candidate related test blocks `NOT_APPLICABLE`; N/A requires a complete, source-scoped scan and `--evidence tests/discovery.json`. For no applicable old tests, document test-source discovery and use explicit N/A; add missing tests where necessary. Never delete or relax an existing test to obtain a green run unless explicitly justified by an approved behavior change.
4. **Automatically validate expected behavior, without routine questions.** Use the actual user requirement/bug report, relevant existing tests, and a narrow source call path. Separate preview/intermediate and final result; current source behavior alone cannot redefine a new requirement. Write and register a small versioned Oracle review with `feedback.mjs oracle --dir FB --file <oracle-review.json>` (see the shared template and v3.6 reference) before target/regression PASS gates. When a failed expectation conflicts with source, do one focused investigation; record `oracle-error`/`assertion-changed` and rerun affected gates. Ask the user only if a material requirement truly cannot be resolved from available evidence, not for each test step.
5. **Derive acceptance and log oracles from real source.** Follow the actual UI → domain → persistence/network chain. Inspect logger wrappers, calculated Tags, prefixes, filtering, thread callbacks, and any custom log implementations; never hardcode the class name as Tag or assume a standard Log API. Start Logcat before UI action and correlate evidence to the specific trigger/input and temporal order. Use an independent UI/state assertion and any available positive downstream completion evidence. Missing necessary log evidence means `INCONCLUSIVE` unless a separate, credible integration assertion establishes the chain; do not fake logs.
6. **Build/install and execute target acceptance.** Use correct project build/installation commands and the bound serial. UI driver selection: **Mobile MCP first → Appium → ADB**, all on the exact same device; ADB is allowed as a Logcat/Crash/Activity sidecar. A backend may fall back during preflight, never after a failed business assertion. Save screenshot, UI hierarchy, Logcat, package/APK metadata where available and source-aware test oracles.
7. **Run connected regressions separately.** Build plans/tests for each required B...N scenario (normal path, exit/re-entry, state reset, other call sites, boundary values); one test can cover multiple scenarios only if actual assertions demonstrate each. Device plan should include `scenarioIds: ["B","C"]`, and a separate Attempt from A. For custom scripts save detailed `attempts/NNN/evidence/scenario-results.json`. Focus on risk-based coverage, not a fixed arbitrary number. Rerun all gates after any subsequent code change.
8. **Finish via THREE evidence-backed gates.** First register the versioned plan with `feedback.mjs impact`; then record `gate target`, `gate existing-tests`, `gate regression`, each pointing to passing attempts and evidence. `existing-tests PASS` needs a fresh nonempty test report; `regression PASS` needs all required scenario IDs. `finish PASS` is allowed only when all three gates are complete, no blocking risks remain and code/oracles are fresh. `FAIL` for a reproduced regression, `INCONCLUSIVE` when critical evidence/coverage is insufficient, `BLOCKED` when environment prevents execution.

## Shared reliability tools

Prefer the frozen `feedback.mjs run` Flash plan for taps/expectations; `target` may include `match: "prefix" | "contains" | "regex"` for dynamic accessible labels, with ambiguity failing closed. Do **not** generate temporary `bounds_center` Bash parsing when the shared locator can compute the center. Use `../taphound-flash/scripts/ui-probe.mjs` for exploratory reads, then freeze the real test in the journal. If using a custom `exec` script that requires logs, include `--require-logcat --device SERIAL --package PACKAGE`: Logcat capture failures then make the Attempt inconclusive, not successful. Avoid Bash 4+ only features on macOS Bash 3.2. Use `newSinceAction: true` on a positive `expect` only when old cached UI could cause a false green. Record test-script/oracle changes in the journal; revised Oracle provenance invalidates prior target/regression PASS gates. `feedback.zip` prioritizes gates/timeline/attempt metadata over large raw logs and includes `zip-manifest.json`.

## Minimal command pattern

```bash
JOURNAL="<absolute skill-root>/taphound-flash/scripts/feedback.mjs"
FB=".taphound/feedback/<unique-id>"
node "$JOURNAL" start --dir "$FB" --skill tap-check --task "<actual user requirement>" --device SERIAL
node "$JOURNAL" impact --dir "$FB" --file .taphound/build/field-tests/<case>/impact-plan.json
node "$JOURNAL" discover --dir "$FB" --project "$PWD" # existing unit-test inventory
node "$JOURNAL" oracle --dir "$FB" --file .taphound/build/field-tests/<case>/oracle-review.json
# Create a target plan with independently meaningful UI + Logcat checks.
node "$JOURNAL" run --dir "$FB" --device SERIAL --backend auto --plan .taphound/build/field-tests/<case>/target.json --apk path/to/debug.apk
node "$JOURNAL" gate --dir "$FB" --gate target --status PASS --attempt 001 --evidence attempts/001/evidence/field-result.json --summary "Observed actual acceptance outcome"
# Run existing tests, capturing the actual test source and JUnit XML/Node TAP:
node "$JOURNAL" exec --dir "$FB" --label related-unit-tests --oracle-file app/src/test/.../RelatedTest.kt -- ./gradlew :app:testDebugUnitTest --rerun-tasks
node "$JOURNAL" gate --dir "$FB" --gate existing-tests --status PASS --attempt 002 --test related-unit --test-report app/build/test-results/testDebugUnitTest/TEST-RelatedTest.xml --evidence attempts/002/stdout.txt --summary "Related original tests executed and passed"
# A different regression plan explicitly lists scenarioIds and asserts each relevant behavior.
node "$JOURNAL" run --dir "$FB" --device SERIAL --backend auto --plan .taphound/build/field-tests/<case>/regression.json --apk path/to/debug.apk
node "$JOURNAL" gate --dir "$FB" --gate regression --status PASS --attempt 003 --scenario B --scenario C --evidence attempts/003/evidence/field-result.json --summary "B/C preserved"
node "$JOURNAL" finish --dir "$FB" --status PASS --summary "Target, old tests and regressions supported by evidence"
```

Example IDs/paths above MUST be replaced with real discovered tests/scenarios/attempt IDs. When none exist, use an explicit `NOT_APPLICABLE` gate with evidence from the inventory rather than inventing a test. If source changes after gates, rerun the affected tests and all three gates. After any outcome (including FAILED/BLOCKED), give the user the `$FB/feedback.zip` path. The feedback ZIP may contain sensitive Logcat, screenshots, source and fixtures: review/redact before sharing. Never claim any finite set of regression tests proves absence of all bugs.
