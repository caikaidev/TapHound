---
name: taphound-bug-fix
description: >-
  Fix one Android bug end to end from a scenario, a bug-tracker ticket, or a
  crash log: read the report (loading the user's bug-tracker reader Skill for
  ticket URLs), pin down the scenario, reproduce it on the device with
  TapHound before touching code, fix it, and prove the same scenario now
  passes with an independent Replay. Stops and reports when the bug cannot be
  reproduced. Use for requests like "fix this bug <ticket>", "fix this crash
  <log>", or "this screen does X when it should do Y".
compatibility: Requires TapHound CLI, adb, an online Android device, and the project's own build/install commands. Logic-only bugs need only the project's unit test toolchain.
metadata:
  author: TapHound
  version: "1.0"
---

# Fix one bug with reproduce-first evidence

This Workflow Skill owns the bug: reading it, deciding the scenario,
reproducing it, changing code, building, installing, and the final call.
TapHound Core owns device execution, Replay, and Verdicts. Never read or
write `.taphound/build/generations`, proposals, or snapshots directly.

The rule that shapes everything: **no reproduction, no fix.** A bug you
cannot reproduce cannot be shown fixed; stop and report instead.

## Where everything goes

Everything stays under `.taphound/`; nothing is written to the project root.

| What | Path | Committed |
|---|---|---|
| Bug record, crash JSON, command outputs, fix report | `.taphound/build/workflows/<caseId>/` | no (ephemeral) |
| Reproduction Brief | `.taphound/briefs/<caseId>/taphound-journey-brief.md` | yes |
| Regression Journey (+ `.meta.json`) | `.taphound/journeys/bugs/<caseId>.json` | yes |
| Regression Contract | `.taphound/contracts/bugs/<caseId>.json` | yes |

`<caseId>` is `bug-` plus a short slug or the ticket key, lowercase letters,
digits, and hyphens, at most 64 characters (for example `bug-mail-1234`).
The code fix itself and, for logic-only bugs, its unit test live in the
project's normal source and test directories. Never overwrite an existing
Journey, Contract, or Brief without the user's permission.

## Helper

`scripts/bug-fix.mjs` (Node.js only, one JSON value on stdout):

```bash
node <skill>/scripts/bug-fix.mjs reader get            # which reader Skill to load
node <skill>/scripts/bug-fix.mjs reader set <skill>    # save yours (per user)
node <skill>/scripts/bug-fix.mjs crash parse <file> [--package <app>]
node <skill>/scripts/bug-fix.mjs crash match <reported> <observed> [--package <app>]
```

`crash parse` normalizes a Java/Kotlin crash (exception chain, root cause,
first app frame), an ANR, or a native signal into a stable `signature`.
`crash match` exits `0` when two crashes share kind, root cause, and first
app frame (`class.method`, line numbers ignored), `1` with the
`differences` otherwise.

## 1. Read the report

Accept one of:

- **A scenario in the request**: use it as written.
- **A bug-tracker URL or ticket key**: run `reader get` and load the Skill it
  names (default `bug-tracker-reader`, a placeholder). If the user names a
  reader Skill in the request, use that one for this run. If the Skill is
  not installed, stop and ask; tell the user they can save theirs with
  `reader set <skill>` (stored in their user config, never in the project;
  `TAPHOUND_BUG_READER_SKILL` overrides it). Never scrape the URL yourself.
- **A crash log** (pasted or a file): save it as
  `.taphound/build/workflows/<caseId>/reported-crash.txt` and run
  `crash parse` with `--package` set to the app package from
  `.taphound/config.json`.

Write `.taphound/build/workflows/<caseId>/bug-record.md` from
`templates/bug-record.md`: source reference, expected vs actual behavior,
steps if given, device/app version if given, crash signature. Keep personal
data, tokens, and raw user content out of it; summarize instead of copying.

## 2. Decide the scenario and reproduce

**Classify first.**

- **Device-observable** (a crash or ANR in the app, wrong or missing UI, a
  screen that does not open): reproduce with TapHound below.
- **Logic-only** (parsing, calculation, data mapping that a unit test can
  reach directly, with no UI needed to observe it): write a unit test in the
  project's test sources that fails for the reported reason, run it, and
  keep the failing output as the reproduction. Then go to step 3.

**Find the scenario.** Use the reported steps when they exist. For a crash
without steps, start from `topAppFrame` and its location: find the screen
(Activity, Fragment, Composable, ViewModel) that runs that code and the user
path that reaches it. Have `taphound-journey-brief-author` write the Brief
with `caseId`, the scenario as `caseGoal`, and
`output: .taphound/briefs/<caseId>/taphound-journey-brief.md`.

**Try it fast (optional).** With the currently installed build, a
`taphound-flash` plan over the path tells you in seconds whether the steps
trigger the bug. It is not evidence.

**Reproduce with evidence.** Drive one generation session with the
`taphound-journey-generator` Skill, bound to the Brief, on the **unfixed**
build:

- Generate the steps leading to the bug normally.
- For the step that triggers the bug, propose the expectation of the
  **correct** behavior (the element or Activity that should appear).
- The bug reproduces when that step fails for the reported reason:
  - a crash: the step fails with `APP_CRASHED`; then save the device crash
    buffer, `adb -s <serial> logcat -d -b crash`, as
    `observed-crash.txt` and run
    `crash match reported-crash.txt observed-crash.txt --package <app>`.
    Only `matched` counts. When the report had no log, record the observed
    signature as the reference.
  - wrong behavior: the step fails with `EXPECT_ELEMENT_FAILED` or
    `EXPECT_ACTIVITY_FAILED`, and the failure message shows the reported
    actual behavior.
- Save each command's JSON output under `repro/` in the workflow
  directory. Do not recover, amend, or finalize this session; it stays held
  as the record of the failure and never publishes.

**Retry budget.** Try the scenario at most 3 times with different reasonable
variations (data, timing, entry path). If it still does not fail as
reported, stop with **NOT_REPRODUCED**: report what you tried, what
happened, and what information would help (exact steps, account state,
app version, device). Do not change code.

## 3. Fix

- Find the root cause from the reproduction, not just the reported line.
- Make the smallest change that fixes it. Do not refactor around it.
- Build and install with the project's own commands (TapHound does not build
  or install). Record the build command and the APK path.
- Re-run the quick `taphound-flash` plan (optional) to catch obvious breakage.

## 4. Prove the fix

Device-observable bugs:

1. In a **new** generation session on the fixed build, bound to the same
   Brief, generate the same scenario with the same correct-behavior
   expectation and finalize it to `.taphound/journeys/bugs/<caseId>.json`.
   For a crash, the step that crashed before must now pass.
2. Write `.taphound/contracts/bugs/<caseId>.json`: a Contract bound to that
   Journey whose assertions state the correct behavior (see
   `docs/contract-schema.md`). Validate it with
   `taphound contract --project <project> --contract <path> --json`.
3. Hand the Case to `taphound-verify-change` in **accept** mode with the same
   `caseId`: its independent
   `taphound verify --contract <path> --policy-from-meta --json` run must
   return Verdict `pass`. Its manifest lands in the same workflow directory.
4. Check nearby behavior: `taphound verify --diff <base-ref> --json` replays
   the committed Journeys the change affects. It is a selector, not the gate;
   report any regression it finds and fix it before finishing.

Logic-only bugs: the unit test from step 2 now passes, and the module's
existing tests still pass.

## Outcomes

Finish with `.taphound/build/workflows/<caseId>/fix-report.md` from
`templates/fix-report.md` and one of:

| Outcome | When |
|---|---|
| `FIXED` | Reproduced as reported, then the same scenario passes (accept Verdict `pass`, or the unit test passes) with no regression found |
| `NOT_REPRODUCED` | The retry budget ran out without the reported failure; no code was changed |
| `FAILED` | Reproduced and changed, but the scenario still fails or a regression appeared; report the evidence |
| `PAUSED` | A required input or tool is missing (reader Skill, device, build), or a step needs human approval (risk confirmations are never inferred) |

Report the root cause, the change, the red and green evidence paths, and the
committed regression assets. Never call a bug fixed on reasoning alone.
