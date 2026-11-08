# v3.5 reliability rules shared by tap-check and tap-fix

Both Skills use the **same** device-safe UI locator, app-derived Logcat checks, existing-tests discovery, and three evidence-backed gates. The Agent must plan the business oracle; helpers do not guess what the app should do.

## 1. Do NOT rewrite UI plumbing in temporary Bash scripts

For common UI actions use a frozen Flash JSON plan through `feedback.mjs run`. The `field-runner.mjs` and bundled ADB Flash share `scripts/ui-locator.mjs`. Targets have exactly one of `id`, `text`, `desc` and optional `match`:

```json
{"action":"tap","target":{"desc":"Messages","match":"prefix"}}
```

Modes: `exact` (default), `prefix`, `contains`, `regex` (JavaScript regex, no implicit case-folding). For a `content-desc` such as `Messages, 46 new notifications`, select with `{"desc":"Messages","match":"prefix"}` **only when** the prefix identifies exactly one element on the live screen. Ambiguous matches are errors, not the first match. Prefer stable resource IDs where available. Bounds parsing supports Android `[left,top][right,bottom]`, clips to ancestors, computes center with correct integer coordinates. The Agent must NOT assume `cut -d,` maps all geometry formats.

For one-off inspection (not a gate), use:

```bash
node '<skill-root>/taphound-flash/scripts/ui-probe.mjs' find --device SERIAL --package com.example.app --desc Messages --match prefix
```

`ui-probe.mjs tap` and `expect` are also available, but **production acceptance must still use `feedback.mjs run`** so the plan and evidence are frozen and replayable. Appium XPath uses exact/prefix/contains; regex falls back to a fresh Appium UI source + deterministic W3C pointer tap. Mobile MCP matches the same target syntax against its accessibility elements. No backend should silently select an ambiguous target.

## 2. Make Logcat capture errors visible

ADB `-d` has different meanings depending on position. `adb -d shell ...` is an alternative global device selector and is forbidden for a serial-bound task; `adb -s SERIAL logcat -d` uses the Logcat *dump* flag and must be allowed. The PATH guard parses ADB global options only, and always retains the bound serial. It is not an OS sandbox.

Prefer source-derived live `logChecks` in the frozen UI plan. Trace logger wrappers, runtime Tag prefixes, disabled levels, processes, correlation IDs and asynchronous callbacks. Logcat is a same-device ADB sidecar even when Mobile MCP drives UI. Never infer a correct business chain merely from button taps or a zero-valued `grep -c` result.

For external shell scripts needing Logcat evidence, add `--require-logcat` to journal `exec --device SERIAL --package PACKAGE`; a failed, empty, truncated or unavailable capture then makes the Attempt `INCONCLUSIVE`, even if the script exited zero. The script must still assert the **right application events** from actual source and must not use `grep`/pipeline exit status to hide an ADB failure. To manually dump Logcat:

```bash
node '<skill-root>/taphound-flash/scripts/logcat-dump.mjs' --device SERIAL --out .taphound/build/field-tests/case/logcat.txt
```

A capture failure exits nonzero and writes a structured failure. Never clear the device Logcat buffer (`logcat -c`) as part of verification.

## 3. Discover related original unit tests before claiming N/A

After registering the impact plan, run:

```bash
node "$JOURNAL" discover --dir "$FB" --project "$PWD"
```

Discovery uses `changedSymbols[].file` and `changedSymbols[].symbol` from the active impact plan. For special cases, explicitly add `--source path/to/Changed.kt` (repeatable) and `--symbol SymbolName`. It inventories test directories, same-module candidates and cross-module symbol references; `tests/discovery.json` and a versioned snapshot go into the feedback ZIP. **It is a conservative heuristic, not a complete call graph.** Inspect dynamic/DI/shared modules separately and extend impact plan with identified tests. If candidates exist, `existing-tests NOT_APPLICABLE` is rejected. An incomplete scan, missing source list, stale Git snapshot, or missing discovery evidence also rejects N/A.

With genuinely no related original tests, use:

```bash
node "$JOURNAL" gate --dir "$FB" --gate existing-tests --status NOT_APPLICABLE \
  --evidence tests/discovery.json --summary 'Inspected affected callers/modules and found no applicable existing tests'
```

Otherwise run all relevant original tests (JUnit/Gradle or Node TAP), including callers and shared consumers. Register `existing-tests PASS` only with a fresh machine test report containing executed and passed tests. Failed or skipped tests require remediation/baseline analysis, not deletion or weakened assertions. If the discovery still cannot rule out a relevant test, record `INCONCLUSIVE` and disclose the gap instead of claiming completeness.

## 4. Behavior regression and script portability

Both Skills require separate target, existing-tests and regression gates. Impact B…N scenarios must be tested independently using explicit assertion-to-scenario mappings. After any code edit rerun all required gates. A passing CLI command alone never proves absence of regression.

Prefer Node.js 22+ helpers over ad-hoc shell parsing. macOS system Bash may be 3.2: do not use `declare -A` or Bash 4+ syntax without checking the interpreter. If the app's More menu is **toggle** controlled, use the same button to close it; do not assume Android BACK dismisses every popup. Derive actual navigation behavior from observed app state and source, and distinguish preexisting behavior from regressions. Never loosen the oracle to hide a broken product behavior.

Every script adjustment must be recorded with `feedback.mjs event --type plan-changed|assertion-changed|diagnosis`. The journal preserves frozen script hashes and all failed Attempts. Do not label a script launch/syntax/ADB failure as a reproduced app Bug. If a custom test script changes between RED and GREEN, `FIXED` remains blocked.

## 5. Bound device always wins over backend selection

Use `--device SERIAL` at case start and throughout. If the specified device is absent, BLOCK, even if another connected device is available. Mobile MCP → Appium → ADB is the **UI backend** order, not permission to switch devices. ADB may collect screenshots, Logcat, Crash and package identity on that same serial. Do not use unscoped Gradle connected-device tests or absolute adb calls to operate other devices. Custom external tools are not confined by PATH, so if binding cannot be verified, stop.
