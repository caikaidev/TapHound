# v3.6 Local feedback, regression gates & device identity

Keep the three Skill directories adjacent. All commands below are run **by the Agent after installing Skills by Copy**, not by the user during installation. Use `node /absolute/path/to/taphound-flash/scripts/feedback.mjs` from the Android project root; no npm dependency or TapHound CLI required.

## Start a new case before editing/testing

```bash
JOURNAL="/ABSOLUTE/PATH/TO/taphound-flash/scripts/feedback.mjs"
FB=".taphound/feedback/<unique-case-id>"
node "$JOURNAL" start --dir "$FB" --skill tap-fix --task "Reported issue / user expectation"
node "$JOURNAL" event --dir "$FB" --type observation --summary "Original expected behavior and actual failure; exact reproduction conditions"
```

Use `--skill tap-check` for feature acceptance. `start` refuses to overwrite a case. `feedback.zip` is generated after every completed journal operation and **never uploaded automatically**.

## Record build/install and identity

Build and install current APK using the application's own commands, through `feedback.mjs exec` when practical. Log the variant and package:

```bash
node "$JOURNAL" exec --dir "$FB" --label build -- ./gradlew :app:assembleDebug
node "$JOURNAL" exec --dir "$FB" --label install -- adb -s SERIAL install -r path/to/app-debug.apk
node "$JOURNAL" event --dir "$FB" --type install --summary "Installed debug APK" --details "variant=debug package=com.example.app device=SERIAL"
```

For each **real device verification**, supply `--device SERIAL --package com.example.app --apk path/to/apk` when using `exec`. `run --plan` infers package from the frozen plan; pass `--apk` explicitly if available. The journal records the local APK SHA-256, installed package paths, versionCode/versionName and, when accessible, on-device APK SHA-256. An exact SHA match is recorded `matched`, a mismatch is `mismatched` (blocks FIXED), and unavailable hash is **`unverified`, not matched**. Split APK/bundle installs may not be comparable by a single digest; record build/install evidence and declare the remaining gap rather than forging provenance.

## Run & capture every attempt

### Preferred: device plan with UI + source-derived Logcat oracles

```bash
PLAN=".taphound/build/field-tests/<case>/plan.json"
node "$JOURNAL" run --dir "$FB" --plan "$PLAN" --device SERIAL --backend auto --apk path/to/app-debug.apk
```

The journal copies the plan to `attempts/NNN/plan.snapshot.json` **and executes that frozen copy**. Existing `field-runner.mjs` records the effective UI backend and probes, UI snapshots, Logcat if configured, screenshots and run result. Skill must verify runtime log predicates against the app's actual logger implementation; no hard-coded Tag assumption.

### For custom shell/UI repro scripts (such as `verify_repro.sh`)

```bash
node "$JOURNAL" exec --dir "$FB" --label repro \
  --device SERIAL --package com.example.app --apk path/to/app-debug.apk \
  --oracle-file .taphound/build/field-tests/<case>/verify_repro.sh \
  -- env SERIAL=SERIAL bash .taphound/build/field-tests/<case>/verify_repro.sh
```

`exec` attempts now automatically:

- Snapshot invoked `.sh`, `.mjs`, `.js`, `.ts`, `.py` (and similar) script files into `attempts/NNN/oracles/`, recording a **file-content based oracle hash**. This catches the observed failure mode where the command text stayed the same while `verify_repro.sh` was edited.
- `--oracle-file FILE` (repeatable) includes test scripts/sourced helpers/fixtures, **actual unit test source when invoking Gradle** or any extra acceptance oracle. These files are snapshotted before each run; an absent or oversized oracle is marked unavailable. `FIXED` requires the same full oracle hash in RED and GREEN, not just the same command. For `gradlew`, `mvnw`, npm/yarn/pnpm, `--oracle-file` specifying the actual test source is required for FIXED.
- With **both** `--device` and `--package` supplied, capture best-effort before/after screenshots, UI hierarchy, Activity and Logcat. Evidence is written to `attempts/NNN/evidence/`, with a `capture-manifest.json` recording capture failures rather than silently dropping them. An ADB sidecar captures logs without clearing the device buffer.
- Expose `TAPHOUND_EVIDENCE_DIR` to the invoked script. The script **should save an in-between screenshot/hierarchy at the actual failure point**, not merely rely on the automatic before/after capture (transient UI overlap could disappear before post-capture). Capture meaningful UI bounds, expected-vs-actual status, and causal logs. Agent must inspect the generated files.
- Record `apk-identity.json`, `oracle-manifest.json`, tracked `changes.patch`, `git-before.json`, `git-after.json`, `stdout.txt`, `stderr.txt`, `attempt.json` in each attempt. Git patch excludes untracked/ignored files; specifically pass script/test files through `--oracle-file`.

`--backend` in `exec` is a **declared** backend label, not an independent runtime probe. The journal's ADB sidecar is not proof that the test's UI driver was ADB. For `run`, effective backend selection comes from field-runner. Use Agent logs to document the actual driver for custom scripts.

### Logcat capture and helper-driven UI probing (v3.5)

Prefer `feedback.mjs run` for device UI operations with `target.match` (exact, prefix, contains, regex), not custom shell coordinate slicing. For an external script which needs positive business-log evidence, add `--require-logcat` to `exec --device SERIAL --package PACKAGE`. If the collector is empty, fails or truncates, the Attempt becomes INCONCLUSIVE even when the external script returns 0. Use `scripts/logcat-dump.mjs` for a checked one-shot capture; never interpret failed `adb logcat` piped to `grep -c` as “no crash.” Source-based positive event assertions are still essential.

### Unit/integration tests

```bash
node "$JOURNAL" exec --dir "$FB" --label unit-red \
  --oracle-file app/src/test/java/.../ReportedBugTest.kt \
  -- ./gradlew :app:testDebugUnitTest --tests '...ReportedBugTest'
```

Do not classify compilation errors, missing executables (126/127), device connection failure or unrelated exceptions as the user-reported Bug. The journal records `INFRA_ERROR` for command launch failures and `UNCLASSIFIED_FAILURE` for generic non-zero commands. The **Agent still has to classify actual reproduction**.

## Validate exact reproduction before fixing

Before code edits, identify a specific failed `attempts/NNN` containing the **reported behavior**, not just a non-zero result. For visual overlaps, verify both widgets' simultaneous visibility and intersecting bounds. For crashes, compare exception/root-cause/first app frame where provided. Only then:

```bash
node "$JOURNAL" event --dir "$FB" --type reproduction-confirmed \
  --attempt 003 --evidence attempts/003/stdout.txt \
  --summary "Actual overlap of both widgets observed" --details "bounds and log correlation"
```

`--attempt` and `--evidence` are mandatory; the evidence file must exist under the **same failed attempt**. The journal rejects a claim referring to an infrastructure/launch failure. It cannot independently parse arbitrary business logs or certify that the reported failure matches: the Agent must provide traceable reasoning and the user can review it.

Before another attempt, record work changes/events: `diagnosis`, `code-change`, `plan-changed`, `assertion-changed`, `instrumentation`, `backend-changed`, `retry`, `verification-gap`. Re-running with modified test oracles is allowed, but **cannot** silently count as identical RED→GREEN.

## Finish safely

```bash
node "$JOURNAL" finish --dir "$FB" --status FIXED --summary "Same original error no longer reproduced; assertions and causal logs pass"
node "$JOURNAL" status --dir "$FB"
```

`FIXED` now requires: a prior confirmed **failed** RED linked to evidence, the **target Gate** linked to a later passing GREEN with matching frozen oracle hashes, plus passing Existing Tests and Regression Gates. `PASS` also requires all three current gates, not simply a passing latest command. Subsequent tests can appear after target GREEN; the target Gate identifies the correct attempt. An oracle mutation, known APK mismatch, blocking risk or stale source/impact plan prevents success. Other statuses: `FAIL`, `FAILED`, `INCONCLUSIVE`, `NOT_REPRODUCED`, `BLOCKED`.

### Required v3.5 impact + three-gate commands

First analyze changed symbols, consumers, existing tests and preservation scenarios following `impact-regression.md`. The Agent creates and records `impact-plan.json` before claiming success:

```bash
node "$JOURNAL" impact --dir "$FB" --file .taphound/build/field-tests/<case>/impact-plan.json
node "$JOURNAL" gate --dir "$FB" --gate target --status PASS --attempt 002 --evidence attempts/002/evidence/field-result.json --summary "Target behavior verified"
node "$JOURNAL" gate --dir "$FB" --gate existing-tests --status PASS --attempt 003 --test related-unit --test-report app/build/test-results/testDebugUnitTest/TEST-Related.xml --evidence attempts/003/stdout.txt --summary "Existing tests really executed and passed"
node "$JOURNAL" gate --dir "$FB" --gate regression --status PASS --attempt 004 --scenario other-caller --evidence attempts/004/evidence/field-result.json --summary "Other caller preserved"
node "$JOURNAL" finish --dir "$FB" --status FIXED --summary "Target, existing tests, regression all passed"
```

`impact-plan.json` names the real project's target, affected scenarios B...N and relevant existing tests; sample file `../templates/impact-plan.example.json` is illustrative only. A regression device plan requires `scenarioIds: ["other-caller"]`, `scenarioChecks: [{"id":"other-caller","assertionSteps":[0]}]` and a real passing `expect` at step index 0; declaring a scenario ID alone cannot satisfy the gate. A custom script uses `attempts/NNN/evidence/scenario-results.json` with version 2, a `scenarios` array of `{id,status:"passed",assertions:[{id:"check",operator:"equals",expected:true,actual:true,evidence:"attempts/003/evidence/observed.json"}]}` (attach each observation as additional `--evidence`). Every required scenario must have a corresponding successful attempt. Existing-test Gate requires a **fresh JUnit XML or Node TAP report** with a nonzero number of *passed* tests; zero, all skipped, stale or failed reports are rejected. The journal saves report copies in `tests/reports/`.

Existing-tests NOT_APPLICABLE additionally requires `feedback.mjs discover --dir "$FB" --project "$PWD"` after impact registration, and `--evidence tests/discovery.json`; the scanner must complete with no candidates. For regression NOT_APPLICABLE an empty relevant scenario list and `--evidence impact/plan.json` suffice. No Gate may silently disappear. A blocked unverified high-risk scenario must be recorded in `risks[]` with `blocking:true` and prevents PASS/FIXED. Source edits **after** a passing Gate invalidate it until retested; source/test/oracle changes must also be explained in timeline. Normal verdicts for uncovered important behaviors are `INCONCLUSIVE` or `BLOCKED`.

### Strict serial binding (best-effort shell guarding)

Use `start --device SERIAL` whenever the user named a device. All device attempts must use the same serial; without an explicit ID, only a uniquely discovered device may be selected. Multiple online devices without a selection must BLOCK. For custom `exec --device SERIAL`, the journal creates a temporary `adb` PATH guard that rejects the wrong `-s` and automatically injects the bound serial for ordinary ADB calls. It also exports `SERIAL`, `ANDROID_SERIAL`, `TAPHOUND_DEVICE_SERIAL`. That does **not** protect absolute ADB paths or Gradle/other tools using their own device selection; an unscoped `connectedAndroidTest` is rejected. Agent must inspect real device identity and never claim OS-level isolation. Mobile MCP is still first UI choice, Appium second, ADB third, all on the **same** selected device. ADB may supply Logcat/Crash/Activity evidence even when MCP performs UI actions.

**Caveats:** `FIXED` still relies on the Agent's truthful reproduction analysis and a meaningful assertion: the journal cannot infer whether a script's `exit 0` is a correct oracle. An unverified device APK, absent Logcat, missing transient UI image, or incomplete test coverage must be disclosed and may warrant `INCONCLUSIVE` even when the journal permits the mechanical FIXED transition. Never weaken the original expected behavior simply to make GREEN.

## User handoff and privacy

After every attempt, the user may inspect `<FB>/summary.md` and `<FB>/feedback.zip`; `timeline.jsonl` tracks events and actions, with all earlier failed attempts retained. **The agent must give the user the ZIP path even when FINISH fails**, and explain why the evidence is incomplete. Review and redact credentials, tokens, personal messages, screenshots, logs, patches and script source before sharing. ZIP creation stays local and applies a 32 MB/file, 70 MB uncompressed total size limit; see `zip-omissions.txt`.

### v3.6 Oracle and ZIP integrity

Before target/regression green gates, run `node "$JOURNAL" oracle --dir "$FB" --file PATH` with a source-backed review (template `../templates/oracle-review.example.json`). The review records a specific trigger, expected outcome, source references, confidence and unresolved assumptions. Updating this review after green invalidates target/regression gates. For cached UI results use `newSinceAction` selectively. Do not ask routine confirmation; unresolved critical product assumptions become INCONCLUSIVE.

`feedback.zip` is critical-first rather than alphabetical: summary, manifest, timeline, all Gate files and Attempt JSON are retained before logs/screenshots. Consult `zip-manifest.json`; incomplete critical metadata is a packaging failure. For detached async tools, an explicit nonterminal `state`/`exit_code` is inconclusive until a terminal result is observed in a new Attempt.

Custom `scenario-results.json` v2 requires actual measured equals assertions **and** separate attached JSON observation evidence. An observation must contain a `measurements` object mapping every assertion id to its actual primitive value, for example:

```json
{"measurements":{"rendered":true,"messageCount":2}}
```

The assertion's `actual` must equal the corresponding saved measurement; both must equal `expected`. The Gate verifies attachment paths and digests, and refuses missing/mismatched values (`CUSTOM_OBSERVATION_MISMATCH`). It records `verificationSources` as `runner-step` or `external-measurements` with an `external-script` attestation label. V1 string-only passes are refused. **This guards against inconsistent self-reports, not a malicious or logically incorrect custom script**; the underlying observation is still external, not independently evaluated UI truth.
