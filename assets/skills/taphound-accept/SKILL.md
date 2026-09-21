---
name: taphound-accept
description: >-
  Verify one intentional Android behavior change against a hash-bound
  Acceptance Contract and an independent TapHound Replay. Record provenance
  and a passing Verdict before promoting a Journey.
compatibility: Requires TapHound CLI, a validated project, and an installed app on an online Android device.
metadata:
  author: TapHound
  version: "1.0"
---

# Accept one Case

Use this Workflow Skill for a new feature, fix, or intentional UI change.
Keep mixed changes separate: one Case per new behavior; run
`taphound-preserve` separately for existing behavior that must remain.
This Skill owns requirements, orchestration, code/build/install provenance,
Contract and final decision, not TapHound Core or Journey proposal internals.

1. Record the Case id (lowercase letters/digits/hyphens, starting with a
   letter), requirement source reference and SHA-256 of a redacted summary.
   Freeze source/implementation and validation-asset diff files separately
   with SHA-256. Do not store secrets or raw Logcat payloads in a manifest.
   Record the chosen `verify --diff` `--base`, `--head` and `--scope`
   (`p0,p1` by default, add `p2` explicitly) or `used:false`.
   `verify --diff` is a selector only, never the Accept completion gate.
2. Ensure the user-approved app is built and installed by the external
   workflow. Obtain a verified published Journey through the
   `taphound-journey-generator` Skill and `generation finalize` when needed;
   this Skill never reads or writes the generation bundle, proposals, or
   snapshots. Validate a hash-bound Contract with
   `taphound contract --project <project> --contract <path> --json`.
3. Start a **new CLI process** for independent device evidence:

   ```
   taphound verify --project <project> --contract <contract.json> --policy-from-meta --device <serial> --json
   ```

   Do not fall back to a looser policy when meta or Context is unavailable.
   For a long-lived Journey, require a published strict replayPolicy and
   matching Journey/Contract/Knowledge bindings. For an intentionally
   hand-authored Journey with no meta, stop at `PAUSED` and ask whether to
   generate a verified Journey; do not claim equivalent finalize policy.
   A passing Contract Verdict **`pass`** with `reportStatus:"passed"` is the
   Accept gate. `fail`, `invalid`, `inconclusive`, `needsReview`, a failed
   Replay, or missing evidence never count as pass.
4. After the gate, optionally promote a long-lived Journey using
   `taphound journey promote --project <project> --journey <journey.json> --reason <reason> --json`.
   A separately requested future Preserve Baseline can be made with
   `taphound baseline capture --project <project> --report <report.json> --verdict <verdict.json> --contract-sha256 <digest> --out <baseline.json> --json`.
   The Baseline is not this Case's pass condition. Never overwrite an
   existing asset without user permission.
5. Persist the reconstructible manifest at the location derived from
   `src/domain/workspace.ts`'s `workflowManifestPath(caseId)`:
   `.taphound/build/workflows/<caseId>/manifest.json`. Validate against
   `src/domain/workflow-manifest.ts`. That build subtree is ephemeral and
   ignored; do not put it beside committed Journeys. Keep command JSON
   outputs in this Case's build directory. Record *each* executed CLI argv,
   process exit code, and JSON result path, plus report/verdict paths, the
   Journey/Contract/Knowledge hashes, replayPolicy meta/hash/strictness,
   requirement digest and both diff digests. Record any pause reason.
   Check the directory is under build and not a symlink before writing;
   do not overwrite an existing manifest or result file silently.

`PASS` requires the Contract Verdict `pass`, a passing report and successful
recorded commands. An explicit refusal, missing precondition, interrupted
recovery or required human approval becomes Workflow `PAUSED` (never a
fabricated Core Verdict). Deterministic failed evidence becomes `FAIL`;
preserve its original CLI result unchanged. No reviewer may rewrite a
deterministic `fail` or `invalid`.
