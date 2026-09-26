# Accept mode

A new feature, fix, or intentional UI change. The gate is a hash-bound
Acceptance Contract whose Verdict is `pass` in an independent Replay.

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
