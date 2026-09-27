---
name: taphound-verify-change
description: >-
  Prove an Android code change does what it should with independent
  TapHound Replays: an intentional behavior change passes a hash-bound
  Acceptance Contract (accept mode), and a refactor preserves previously
  captured behavior by Baseline comparison (preserve mode). Records a
  provenance manifest per Case. Use when an Android code change must be
  proven before it is called done: new features with or without UI changes,
  refactors, and UI migrations such as XML to Compose.
compatibility: Requires TapHound CLI, a verified Journey (or one generated first), and an installed app on an online Android device.
metadata:
  author: TapHound
  version: "1.0"
---

# Verify one code change

This Workflow Skill turns "the change is done" into evidence. It owns the
Case, build/install provenance, and the final decision; TapHound Core owns
Replay, Verdicts, and Baselines. Never read or write
`.taphound/build/generations`, proposals, or snapshots.

## Choose the mode per Case

Classify every change before coding starts; preserve needs evidence from the
**pre-change** app.

| The change                                            | Mode and path                         | Gate                                              |
|-------------------------------------------------------|---------------------------------------|---------------------------------------------------|
| 1. New behavior without UI changes (data, logic, API) | accept, via an existing UI flow       | Contract `pass`; prove the behavior with `logcatEvent` assertions on structured app logs |
| 2. New behavior with UI changes                       | accept, with a newly generated Journey | Contract `pass`                                   |
| 3. Refactor with no UI change                         | preserve, Baseline                    | `baseline compare` `equivalent: true`             |
| 4. UI toolkit migration (for example XML → Compose)   | preserve, large UI refactor           | the new Journey proves every frozen observable    |
| 5. Major structural UI change in the same toolkit     | preserve: Baseline if the old Journey still replays on the new build, otherwise large UI refactor | as above |

Read `references/accept.md` for accept and `references/preserve.md` for
preserve (its "Large UI refactor" section covers 4 and 5). Generate any
missing Journey with the `taphound-journey-generator` Skill first.

One Case covers one behavior. A change that adds behavior and must keep
other behavior is several Cases, each in its own mode; no result substitutes
for another. If pre-change evidence no longer exists for a preserve Case,
the Case is `PAUSED`, never reconstructed from post-change behavior.

For a quick smoke check while still coding, use `taphound-flash`; it is not
evidence and never replaces this Skill's gate.

## Shared rules

- **Case id**: lowercase letters, digits, and hyphens, starting with a
  letter, at most 64 characters.
- **Independent Replay**: every gate run is a new `taphound verify` process
  with `--policy-from-meta`. Never fall back to a looser policy when meta or
  Context is unavailable; stop at `PAUSED` instead.
- **Selectors are not gates**: `verify --diff` may choose extra affected
  Journeys; record its `--base`, `--head`, and tiers (`p0,p1` by default)
  or `used: false`, but it never decides the Case.
- **Outcomes**: `PASS` only on the mode's gate with successful recorded
  commands. Deterministic failed evidence is `FAIL`; keep its CLI result
  unchanged. A refusal, missing precondition, interrupted recovery, or
  required human approval is `PAUSED` with a reason, never a fabricated
  Verdict. No reviewer may rewrite a deterministic `fail` or `invalid`.
- **Never overwrite** a Journey, Contract, Baseline, manifest, or result
  file without the user's permission.

## Provenance manifest

Write one manifest per Case at `.taphound/build/workflows/<caseId>/manifest.json`
and keep each command's JSON output in that directory. The build subtree is
ephemeral and Git-ignored; check the directory is under it and not a
symlink before writing. `schemas/workflow-manifest.schema.json` gives the
exact shape (`case.path` is `accept` or `preserve`). Core also enforces:

- every `commands[].jsonResultPath` and `diffs.*.path` lies inside
  `.taphound/build/workflows/<caseId>/` (normalized, relative, `/`
  separators);
- `outcome.path` equals `case.path`, and `PAUSED` has a `pauseReason`;
- `PASS` needs `evidence.reportPath`, at least one command, every
  `exitCode` 0, and `bindings.replayPolicy.strict: true`;
- accept `PASS` also needs `outcome.verdict: "pass"`,
  `evidence.verdictPath`, and `bindings.contractSha256`;
- preserve `PASS` also needs `outcome.equivalent: true` and
  `evidence.beforeReportPath`, `baselinePath`, and `compareResultPath`.

Record each executed CLI argv, exit code, and JSON result path; the
Journey, Contract, Knowledge, and replayPolicy bindings; the requirement
source reference and the SHA-256 of a redacted summary; and the
implementation and verification-asset diffs as separate files with
SHA-256. Do not store secrets, raw request data, or raw Logcat payloads.
Never treat another Case's result as this Case's proof.
