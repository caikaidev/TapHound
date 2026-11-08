---
name: taphound-flash
description: >-
  Android 快速冒烟测试：“冒烟一下”“快速检查页面能否打开”时使用。Lightweight UI runner and shared test utility for tap-check/tap-fix; NOT a substitute for full change acceptance or bug repair.
compatibility: Node.js 22+, Android device/emulator; Mobile MCP/Appium/ADB for UI and ADB for optional Logcat checks. No TapHound CLI/install script.
metadata:
  author: TapHound
  version: "3.6-copy-ready"
---

# TapHound Flash — copy-ready UI + Logcat runner v3.6

This is a standard Skill folder with `SKILL.md`, `scripts/` and optional `references/`, `templates/`. Copy **all three** TapHound Skill folders side by side to your Agent's skills directory. No installer; invoking a test runs the bundled Node script.

The runner is `scripts/field-runner.mjs`, invoked via the **required** feedback wrapper `scripts/feedback.mjs` for business verification. Every test attempt produces a separate preserved evidence directory. Read `references/v36-oracle-evidence.md`, `references/v35-reliability.md`, `references/feedback-workflow.md` and `references/impact-regression.md` before using this Skill to verify a change or bug fix. ADB-only UI operations are delegated to the bundled `scripts/flash.mjs`. Node 22+; no mandatory npm dependencies for these scripts. Mobile MCP requires `mcp-server-mobile`; Appium requires a working UiAutomator2 server. `auto` tries **Mobile MCP → Appium → ADB**; after a test begins, a failed assertion does not cause a backend switch.

## Test plan

Flash v1 UI steps: `tap`, `type`, `back`, `wait`, `expect`, `expectActivity`, with `target:{"id":"..."}` or `{"text":"..."}` or `{"desc":"..."}` and optional `"match":"exact|prefix|contains|regex"`. Ambiguous elements fail; no guessing pixel coordinates. `type` using ADB supports printable ASCII only.

For a real behavior check, set `"verificationMode":"full"` and add `"logChecks"`. Each check specifies an `id`, `fromStep` (zero-based index of the action triggering the work) and one or more **source-derived** match fields. Optional fields: `messageContains`, `messageRegex`, `tag`, `tagRegex`, `rawContains`, `rawRegex`, `toStep`, `minCount`, `maxCount`, `orderGroup`, `timeoutMs`, `sourceRef`. Tags/prefixes/format are **never** hardcoded by the Skill; see `references/log-evidence.md` before authoring checks. The bundled `templates/full-chain-example.json` is illustrative, not a ready-to-run test of your app.

Logcat comes from the **same device via ADB** even when Mobile MCP or Appium executes UI steps. The collector starts before launch, inserts a unique marker to exclude old Logcat entries, records per-step host receive windows, and writes a local `logcat.txt` plus check counts/line hashes in JSON. It observes `main`, `system`, and `crash` Android buffers; it cannot prove logging captured by private files/external telemetry systems. For full-chain verification, a positive completion log is required, in addition to an independent UI/business result.

## Commands (journal first; no installer needed)

```bash
JOURNAL="<absolute-path-to-this-skill>/scripts/feedback.mjs"
FB=".taphound/feedback/<unique-case-id>"
PLAN=".taphound/build/field-tests/<case>/plan.json"
node "$JOURNAL" start --dir "$FB" --skill tap-check --task "User requirement"
node "<absolute-path-to-this-skill>/scripts/field-runner.mjs" probe "$PLAN" --device SERIAL
node "$JOURNAL" run --dir "$FB" --plan "$PLAN" --device SERIAL --backend auto
# Register impact plan, discover existing tests, record source-backed Oracle review, execute unit tests and B..N regression.
# Record THREE independent gates with real evidence before finish PASS/FIXED.
node "$JOURNAL" finish --dir "$FB" --status PASS --summary "What was proven"
# Review $FB/summary.md; share $FB/feedback.zip after redaction.
```

Use `--skill tap-fix` and a suitable outcome when troubleshooting bugs. **Always use the journal for test runs in either business Skill.** `start` and every subsequent journal operation produce an updated local ZIP; tests are executable commands but copying/installing the Skill never requires running a setup script. See `references/feedback-workflow.md` for events, preserved attempts, focused unit tests, and verdict constraints.

Use `--backend mobile-mcp|appium|adb` to pin UI backend; default is `auto`. **Mobile MCP remains first priority**. When several Android devices are connected, always explicitly use `--device SERIAL`; bind the same serial in `feedback.mjs start --device SERIAL` and all tests. The runner refuses an arbitrary Appium session without a verified device UDID. Different connected devices are never valid fallback choices. ADB may remain a same-device Logcat/Crash/Activity sidecar when UI runs through MCP or Appium. `--require-crash-check` insists on an auxiliary ADB process/Crash check. `TAPHOUND_MCP_COMMAND` overrides the MCP executable, `TAPHOUND_APPIUM_URL` the local Appium endpoint, and `ADB` the ADB executable.

Exit status: `0` PASS, `1` FAIL (demonstrable mismatch), `2` invalid plan, `3` environment error, `4` INCONCLUSIVE (required positive logs missing, incomplete logcat, or full mode has no log oracle). Inspect `field-result.json` and `logcat.txt`; for ADB UI-only runs also see `result.json`. A green UI action alone never proves an app's downstream chain in full mode.

## Cautions

- The agent must inspect actual project log wrappers, dynamically constructed Tags, filters, prefixes, and async callbacks before writing `logChecks`. A missing log **is not automatically an app regression**; treat it as insufficient evidence. A log from an unrelated request is not a valid success: use narrow action windows and correlation IDs where applicable.
- Ask approval for destructive/sensitive actions, avoid real account data. `logcat.txt` can contain secrets; keep it local and redact before sharing.
- An Activity or process check can require ADB; a missing capability is not a product failure. `--backend auto` changes providers only at preflight, not after executing test steps.
- Local synthetic tests are not real-device assurance. Verify Mobile MCP/Appium/ADB operation on your own device and report actual backend/build identity.

## v3.3 additional evidence for custom commands

For an external repro shell script, use `scripts/feedback.mjs exec --dir FB --device SERIAL --package PACKAGE --apk APK --oracle-file verify_repro.sh -- env SERIAL=SERIAL bash verify_repro.sh`. This snapshots executed scripts and test oracles; the custom script can write transient evidence to `$TAPHOUND_EVIDENCE_DIR`. The wrapper captures before/after screenshot/hierarchy, Logcat (no buffer clearing) and APK metadata when possible. `FIXED` requires a linked RED evidence file (`event --type reproduction-confirmed --attempt NNN --evidence attempts/NNN/<file>`), identical oracle hashes and a passing GREEN. An unavailable digest is reported as unverified, not verified. See `references/feedback-workflow.md`.

## v3.4–v3.6 shared regression & test gate

Both business Skills MUST record a versioned impact plan (`feedback.mjs impact --file ...`) and independent gates (`feedback.mjs gate --gate target|existing-tests|regression`) before `finish PASS/FIXED`. Existing relevant unit tests need actual nonempty JUnit XML / Node TAP evidence, and all required affected scenarios must be checked using a distinct regression Attempt with explicit `scenarioIds` plus a `scenarioChecks` mapping to actual passing assertion steps in a device plan, or `evidence/scenario-results.json` from a custom runner. This prevents silently accepting "fixed A but broke B". A changed tracked/untracked source file or a revised impact plan invalidates previous passing gates. If a gate is legitimately inapplicable, record `NOT_APPLICABLE` with a saved inventory rationale, not an undocumented skip. See `references/impact-regression.md`.

Custom device commands started with `feedback.mjs exec --device SERIAL` use a best-effort ADB PATH wrapper (`scripts/device-guard.mjs`) to force or validate `adb -s SERIAL`. It is **not** a system-level sandbox and cannot constrain absolute ADB paths, non-ADB external tools or Gradle's separate device management. Unscoped `connectedAndroidTest` invocations are deliberately rejected; use a verified device-scoped instrumentation command. The feedback ZIP shows the actual device-binding and isolation level.

## v3.5 retained reliability updates

- `scripts/ui-locator.mjs`: shared deterministic match modes, Android/Appium XML attribute decoding, robust bounds center computation and ambiguity failure. Use `scripts/ui-probe.mjs` for one-off inspection; journaled JSON plans for verification. No more hand-rolled `cut -d,` bounds parsing.
- `scripts/device-guard.mjs`: parse only the leading ADB *global* flags. `adb -s SERIAL logcat -d` now means Logcat dump and is allowed; `adb -d shell ...` is still refused because that `-d` is a global device selector.
- `scripts/logcat-dump.mjs`: one-shot, device-scoped Logcat evidence with nonzero exit on read failure or empty capture. `feedback.mjs exec --require-logcat --device SERIAL --package PACKAGE` fails closed to `INCONCLUSIVE` when the evidence stream is unavailable or truncated. Script authors must still verify actual app events, not just collector success.
- `feedback.mjs discover --dir FB --project PROJECT`: records `tests/discovery.json` with source-aware related test candidates (same module plus cross-module symbol references) and scan warnings. `existing-tests NOT_APPLICABLE` requires this current snapshot and no candidates. This is a conservative heuristic, not exhaustive call-graph proof.
- Prefer Node.js 22+ over Bash-only map/regex idioms; macOS system Bash may be 3.2. Do not assume BACK closes a toggle menu.

## v3.6 provenance, freshness, and archive integrity

Both business Skills record `feedback.mjs oracle --dir FB --file <oracle-review.json>` after a small task/source/old-test expectation check, before PASS gates. No routine user confirmation or fourth independent Gate. The source review is versioned and its SHA-256 bound to target/regression green gates; later oracle revisions make old gates stale. See `templates/oracle-review.example.json` and `references/v36-oracle-evidence.md`.

Opt-in `expect.newSinceAction:true` rejects an expected result already visible before the preceding tap/type/back. It adds a pre-action observation and should be used for output that must be newly produced, not every basic existence check. `plan.launchMode:"launcher"` explicitly starts through the exported public launcher even when an internal Activity appears elsewhere in the plan; ADB Flash also tries Launcher on known non-exported Activity startup errors. Appium retries without `appActivity` when it detects an equivalent export denial, keeping the same verified UDID.

`feedback.mjs exec` refuses a spurious PASS for a structured nonterminal task status such as `state:running, exit_code:null`. `feedback.zip` always selects `summary.md`, Gate JSON, timeline, oracle/impact plans and attempt metadata ahead of large logs. Read `zip-manifest.json` for completeness and `zip-omissions.txt` for skipped large raw evidence. An incomplete archive is not independently auditable; raw files remain available on disk.
