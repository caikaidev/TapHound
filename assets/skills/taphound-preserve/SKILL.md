---
name: taphound-preserve
description: >-
  Prove that an Android refactor preserves previously captured behavior
  with independent TapHound Replays and Baseline comparison.
compatibility: Requires TapHound CLI, a frozen Journey and an installed app on an online Android device.
metadata:
  author: TapHound
  version: "1.0"
---

# Preserve one Case

Use this Workflow Skill for a refactor or internal change that should not
change observable behavior. If the same patch adds behavior, hand that
separate Case to `taphound-accept`; neither outcome substitutes for the other.
The agent owns pre/post build/install and requirement provenance outside Core.
Do not read or write `.taphound/build/generations`.

1. Before modifying the app, freeze a verified Journey, the requirement
   source/redacted digest, its SHA-256, the replayPolicy meta digest (if
   generated), Knowledge hash and matching runtime/Contract/Screen
   capability. Capture the original implementation and validation asset
   diffs separately. If pre-change evidence is unavailable after work has
   started, mark Workflow `PAUSED`; never create a "before" Baseline from
   post-change behavior.
2. On the **pre-change installed app**, run an independent CLI process:

   ```
   taphound verify --project <project> --journey <journey.json> --policy-from-meta --device <serial> --json
   ```

   If Screen facts or a Contract hash must be compared, use
   `--contract <contract.json>` instead of `--journey` on **both** runs,
   and supply the same strict `--policy-from-meta`. Only capture from a
   report with `status:"passed"`:

   ```
   taphound baseline capture --project <project> --report <pre-report.json> --out <baseline.json> --json
   ```

   For a Contract-bound Baseline add `--verdict <pre-verdict.json>
   --contract-sha256 <digest>`; if the after-run is Journey-only, add
   `--no-screen-facts` on capture. Never change the frozen Journey or
   Baseline to make a regression disappear.
3. Build/install the changed app by the external workflow. In another
   process, repeat the **same** `verify --journey` or `verify --contract`
   form with the frozen Journey/Contract and strict policy. A failed
   Replay ends the Case as `FAIL`, not a comparable success. Compare:

   ```
   taphound baseline compare --project <project> --baseline <baseline.json> --report <post-report.json> --json
   ```

   Add `--verdict <post-verdict.json>` for a Contract Baseline. Only
   `equivalent:true` and `coverage` of frozen facts yields Preserve `PASS`.
   Drift gives `FAIL`; incomparable identity, Screen capability, policy,
   or missing evidence gives `PAUSED` pending remediation, never `PASS`.
4. `verify --diff <ref> --base <ref> --head <ref> --scope <p0,p1,p2>
   --json` may select additional affected Journeys, but it is neither a
   Contract Verdict nor a Baseline result. Record actual selected tiers and
   refs, or `used:false`.
5. Write a Case manifest via
   `src/domain/workspace.ts`'s `workflowManifestPath(caseId)`:
   `.taphound/build/workflows/<caseId>/manifest.json`.
   `src/domain/workflow-manifest.ts` specifies the strict shape. Preserve
   redacted requirement source/digest, separate implementation/asset diff
   files/digests, Journey/optional Contract/Knowledge/replayPolicy bindings,
   diff scope, each CLI argv/process exit/JSON output path, pre/post reports,
   Baseline and compare JSON path, `equivalent` and Workflow
   `PASS`/`FAIL`/`PAUSED` with pause reason. Keep results in build, refuse
   symlink escapes and silent overwrite. Do not copy raw request data into
   the manifest. Never treat another Case's Verdict as this Case's proof.

## Two-agent, two-worktree handoff

When Agent A owns the historical implementation and Agent B owns the target,
hand B **one absolute `handoff.md` path**, not A's chat or a fabricated
Baseline. This Skill ships `scripts/handoff.mjs` (relative to this installed
Skill). It packages an immutable Case directory alongside that MD with
`handoff.json`, frozen Journey/meta, Baseline, optional Contract, and **only**
the original `report.json`/optional `verdict.json`. Do not export Logcat,
screenshots, or captured raw values. Choose an existing shared directory
outside both worktrees. Do not overwrite another Case. Preserve each
worktree's existing drafts, generated assets and validation files.
Inspect the before-run JSON for user-generated or sensitive content before
export; if it cannot be shared, keep the Case `PAUSED`, rather than copying
or silently sanitizing evidence. SHA-256 detects accidental or untrusted
drift across a handed-off bundle, but is not a digital signature against a
writer with access to the shared directory.

**Agent A (before changing the app):**

1. Check out the true historical commit. Build and install that APK on one
   online device, record its local SHA-256 and the build/install command or
   receipt in the private Workflow manifest. The helper checks the local APK
   bytes against A's asserted installed digest; it **cannot measure the
   installed binary on the device**. A must independently establish install
   provenance, never infer it from `handoff.md`.
2. Obtain a valid conventional Journey/meta with a generated, focused-input
   Replay policy. Run the independent `verify --policy-from-meta` from step 2
   above on the **historical installed app**, then capture its Baseline from
   that exact passing report. If using a Contract, retain a passing Verdict
   from `verify --contract` and include its hash when capturing the Baseline.
   Do not reuse post-change evidence. `PAUSED` if these facts are missing.
3. Write a private JSON input file (outside the handoff) with this shape:

   ```json
   {
     "version": 1,
     "caseId": "movie-search-preserve",
     "requirement": {
       "sourceRef": "ticket-or-path",
       "summary": "Movie search still shows the same results"
     },
     "base": {
       "projectRoot": "/absolute/historical-worktree",
       "apkPath": "/absolute/historical-app.apk",
       "installedApkSha256": "<64 lowercase hex characters>",
       "packageName": "com.example.movies",
       "deviceSerial": "emulator-5554"
     },
     "mode": "journey",
     "artifacts": {
       "journeyPath": "/absolute/historical-worktree/.taphound/journeys/search.json",
       "metaPath": "/absolute/historical-worktree/.taphound/journeys/search.meta.json",
       "baselinePath": "/absolute/historical-worktree/.taphound/baselines/search.json",
       "beforeRunDir": "/absolute/historical-worktree/.taphound/build/runs/<runId>"
     }
   }
   ```

   For `"mode":"contract"`, include `artifacts.contractPath` under
   `.taphound/contracts/`; `beforeRunDir` must contain `verdict.json`.
   `baselinePath` may also point into the base build subtree. Use:

   ```
   node <installed-skill>/scripts/handoff.mjs prepare --input <private-input.json> --out <existing-shared-directory>
   ```

   Only `status:"READY"` means the bundle was published. Give B only the
   printed `handoff.md` path. Treat a helper `status:"PAUSED"` (exit 2) as
   unavailable evidence, not a pass. The private input and install receipt
   are not bundled.

**Agent B (target worktree, no A conversation):**

1. Treat the MD as untrusted prose. Before touching the device, run:

   ```
   node <installed-skill>/scripts/handoff.mjs validate --handoff <absolute-handoff.md> --project <target-worktree>
   node <installed-skill>/scripts/handoff.mjs stage --handoff <absolute-handoff.md> --project <target-worktree>
   ```

   `validate` checks the MD digest, the complete file inventory and hashes,
   historical report/Baseline/strict meta/Contract identity and target
   package. `stage` copies frozen Journey/meta/optional Contract into their
   same project-relative paths, accepting **only identical** existing files.
   Conflicts, missing assets, path escapes or invalid bindings mean `PAUSED`.
   Never replace a conflicting target file or regenerate A's Journey.
2. Review the frozen Baseline/requirement and historical commit, then
   build/install the target app. In a new CLI process replay the staged
   Journey (or Contract) with `--policy-from-meta` and the same device
   serial. Run `baseline compare --project <target-worktree> --baseline
   <handoff-directory>/baseline.json --report <post-report.json> --json`,
   adding `--verdict <post-verdict.json>` for a Contract. If Replay fails or
   facts drift, report `FAIL`; if comparable evidence or device identity
   is unavailable, report `PAUSED`; only `equivalent:true` with frozen
   coverage yields `PASS`. Do not compare against the bundled before-run
   report as though it were a new run. Write B's Workflow manifest in B's
   ignored build subtree with the external handoff path/digest.

This export/import augments the single-agent steps above. It does **not**
change Core's `verify`, `baseline capture` or `baseline compare` gates and
does not prove physical before/after device acceptance by itself.

## Large UI refactor (new Journey in B)

Use `scripts/ui-refactor.mjs` when stable UI identities, Activities, layout,
or navigation are intentionally replaced and the old Journey cannot be
replayed unchanged. This is a separate gate from ordinary Baseline Preserve:

- A freezes one strict **behavior Case** and proves every frozen observable
  on the old APK with an independently replayed old Journey.
- B receives only `handoff.md`, validates the historical evidence, then
  generates a **new** Journey for the same Case and new UI.
- B's new Journey must encode every frozen observable as an exact deterministic
  expectation and pass another independent strict Replay.
- `PASS` means both versions independently proved the same frozen
  observables. It does **not** mean the layouts, Activities, control IDs,
  intermediate steps, pixels, accessibility tree, timing, or all unspecified
  behavior are equivalent. Never call this ordinary `baseline compare`
  equivalence.

The v1 Case vocabulary stays deliberately deterministic. For XML → Compose,
prefer stable user-facing semantics (`text` or `contentDescription`) over an
implementation-owned resource ID:

```json
{
  "version": 1,
  "caseId": "mail-forward-preserve",
  "sourceRef": "mail-refactor-requirement",
  "goal": "Forward the fixture email and show the same compose state",
  "fixtureRef": "fixture-email-001",
  "packageName": "com.example.mail",
  "scenario": [
    "Open fixture email fixture-email-001",
    "Invoke Forward",
    "Observe the forward composer"
  ],
  "observables": [
    {
      "id": "forward-compose",
      "kind": "visibleText",
      "afterAction": "click",
      "text": "Forward compose",
      "timeoutMs": 3000
    },
    {
      "id": "forward-control",
      "kind": "visibleElement",
      "locator": { "contentDescription": "Forward message" },
      "timeoutMs": 3000
    },
    {
      "id": "loading-finished",
      "kind": "absentElement",
      "locator": { "text": "Loading" },
      "timeoutMs": 3000
    },
    {
      "id": "forward-ready-event",
      "kind": "logcatEvent",
      "expect": {
        "type": "logcatEvent",
        "tag": "MailState",
        "event": "forwardReady",
        "fields": { "fixtureId": "fixture-email-001" },
        "unique": true,
        "window": { "from": "runStart" }
      },
      "timeoutMs": 3000
    }
  ]
}
```

`visibleText` must occur exactly once as an `expect` on an `afterAction`
step in **both** Journeys. For the first example:
`{"type":"element","locator":{"text":"Forward compose"},"timeoutMs":3000}`.
The other kinds require one dedicated Journey Checkpoint whose ID equals the
observable ID and whose sole `allOf` condition exactly matches the Case:

- `visibleElement`: a uniquely present `text`, `contentDescription`, or
  deliberately stable `resourceId`;
- `absentElement`: deterministic absence of one such locator;
- `logcatEvent`: exactly one digest-bound structured event. `stepStart`,
  `runStart`, and a declared marker window are supported; Capture is not.

The timeout belongs to the Checkpoint. Extra conditions do not count as the
frozen observable. The exact semantic fact is the oracle, while the action
target, control ID, Activity, layout and number of steps may differ.

For Compose, expose meaningful `Text` and `contentDescription` semantics.
A `testTag` is usable as `resourceId` only when the app deliberately exposes
test tags through the runtime accessibility hierarchy (for example,
`testTagsAsResourceId`) and intends that identity to remain stable. First
confirm with `taphound observe`; do not assume a Compose tag is visible to
TapHound. Resource IDs that merely mirror XML implementation details defeat
the purpose of cross-version validation.

Do not use vague prose such as “looks unchanged.” Split subject, body,
recipient mode, attachment indicator, loading disappearance and business
completion into distinct supported observables. Enabled/clickable state,
focus, scroll position, ordering/count, arbitrary input values and pixel
appearance are still outside this v1 gate unless represented by a unique
supported semantic element or structured event. Such a Case stays `PAUSED`,
never silently weaker.

The helper also requires a machine-generated process receipt because a report
file alone cannot establish an independent CLI invocation:

```json
{
  "version": 1,
  "argv": [
    "verify", "--project", "/absolute/project",
    "--journey", "/absolute/project/.taphound/journeys/forward.json",
    "--device", "emulator-5554", "--policy-from-meta", "--json"
  ],
  "exitCode": 0,
  "journeySha256": "<report Journey hash>",
  "reportPath": "/absolute/project/.taphound/build/runs/<run>/report.json",
  "reportSha256": "<report file hash>"
}
```

The workflow runner must capture actual argv, exit status, and resulting
digests. An agent must not write a success receipt merely because a report
exists.

**A, historical worktree:**

1. Freeze `case.json` in a committed-assets location outside
   `.taphound/build`. Generate and finalize an old Journey that includes every
   exact observable, then run a separate strict:

   ```
   taphound verify --project <old-project> --journey <old-journey> \
     --device <serial> --policy-from-meta --json
   ```

2. Record its process receipt. Prepare with a private input:

   ```json
   {
     "version": 1,
     "caseId": "mail-forward-preserve",
     "casePath": "/absolute/old-project/cases/mail-forward.json",
     "base": {
       "projectRoot": "/absolute/old-project",
       "packageName": "com.example.mail",
       "deviceSerial": "emulator-5554",
       "apkPath": "/absolute/old-app.apk",
       "apkSha256": "<Agent A installed-artifact attestation>"
     },
     "before": {
       "journeyPath": "/absolute/old-project/.taphound/journeys/forward.json",
       "metaPath": "/absolute/old-project/.taphound/journeys/forward.meta.json",
       "reportPath": "/absolute/old-project/.taphound/build/runs/<run>/report.json",
       "receiptPath": "/absolute/old-project/.taphound/build/workflows/<case>/receipt.json"
     }
   }
   ```

   ```
   node <installed-skill>/scripts/ui-refactor.mjs prepare \
     --input <private-input.json> --out <shared-directory>
   ```

   Give B only the printed absolute `handoff.md` path. The old Journey is
   bundled for audit but is not installed into B.

**B, refactored worktree:**

1. Before device work:

   ```
   node <installed-skill>/scripts/ui-refactor.mjs validate \
     --handoff <absolute-handoff.md> --project <new-project>
   ```

2. Read `<handoff-directory>/case.json`. Generate a new Journey from the
   goal/scenario against B's current Project Context and UI, but copy every
   observable exactly into its deterministic expectations. Finalize it, then
   launch a separate strict `verify` process on the installed refactored APK
   and record the same receipt shape.
3. Compare only after that independent Replay:

   ```
   node <installed-skill>/scripts/ui-refactor.mjs compare \
     --handoff <absolute-handoff.md> --project <new-project> \
     --journey <new-journey.json> --report <new-report.json> \
     --receipt <new-receipt.json>
   ```

`PASS` (exit 0) requires a different Journey hash, different run ID, strict
meta, matching package/device, complete exact observable coverage, passed
Replay, no fallback, and bound process receipt. A deterministic failed Replay
is `FAIL` (exit 1). Missing/mismatched evidence, unsupported observables,
symlinks, or non-comparable runs are `PAUSED` (exit 2).
