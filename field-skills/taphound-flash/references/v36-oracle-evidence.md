# v3.6 · Fast, source-backed expectation checks (no routine user prompts)

## Why this exists
An Android UI may show a cached result after an unrelated click; a test might wrongly expect an async result immediately even though the app actually shows a preview and requires a second user action. This is an **oracle error**, not proof the app is broken. Both `tap-check` and `tap-fix` must build credible expectations *before testing*, but should not repeatedly interrupt the user.

## Bounded automatic pass

1. Take the **current task statement/bug report** as authority for intentionally changed behavior. For preserved behavior, inspect the most local existing tests, the UI handler, ViewModel/state transition, and any relevant repository callback. Do NOT read the whole project by default.
2. Distinguish `when` (trigger), intermediate states (preview/loading/confirmation) and `then` (observable result). An implicit click on Send is not allowed just because a later result exists in the UI.
3. Cite actual source evidence; trace wrappers for Logcat tags/prefixes dynamically, never assume that class name equals Tag. Every necessary final assertion needs a source-backed oracle entry.
4. If an assertion fails, first distinguish app failure from wrong precondition/sequence, stale UI, backend mismatch, timeouts and log-collection failures. Perform **one focused follow-up** on the affected path when new evidence justifies it. Do not repeatedly scan the whole tree or repeatedly solicit user approval.
5. If an expectation is found incorrect, preserve its version, write `feedback.mjs event --type oracle-error` or `--type assertion-changed` with the concrete reason and evidence, register a revised oracle, and **rerun affected gates**. Do not weaken a test merely because it failed.
6. If still uncertain, continue independent tests, but mark the affected essential expectation `uncertain` or a blocking uncertainty. Do not call `PASS/FIXED`; use `INCONCLUSIVE`. Ask a user only for a genuinely undecidable product requirement, destructive/sensitive action or a required missing input.

## Record source-backed expectations

Create a small JSON file from `templates/oracle-review.example.json`, not a new large framework. Before PASS target/regression gates run:

```bash
node "$JOURNAL" oracle --dir "$FB" --file .taphound/build/field-tests/<case>/oracle-review.json
```

The file must contain `version:1`, `expectations[]` (nonempty) and `uncertainties[]` (may be empty). Each expectation has a unique `id`, `scope: target|regression`, `when`, `then`, `confidence: supported|uncertain`, and a nonempty `sources[]` of `{kind,ref}`. Valid source kinds: `requirement`, `bug-report`, `existing-test`, `source-code`, `runtime-evidence`. A **target** expectation may not derive solely from current source/observations, since buggy implementations do not define correct requirements.

The journal versions each Oracle review and stores its hash. Target/Regression PASS gates reference it. Rewriting or re-registering the oracle after a green Gate makes the Gate stale until rerun. An essential uncertain expectation blocks a final clean verdict; the Agent should not invent a user confirmation to bypass this.

## Prove the result is new when relevant

For results that could already be visible (previous AI message, saved result card, cached list), put `"newSinceAction": true` on a **positive** `expect` following a `tap`, `type` or `back`. It verifies that the same target did **not match immediately before the preceding action**, then waits for it afterward. If already present, the step fails `STALE_EXPECTATION`; if the prior observation is missing, it fails `FRESHNESS_UNVERIFIED`. Example:

```json
{"version":1,"packageName":"com.example.app","steps":[
  {"action":"tap","target":{"id":"send_summary"}},
  {"action":"expect","target":{"desc":"Summary completed for request 123"},"newSinceAction":true}
]}
```

This check does **not** automatically prove a network request belongs to this action if the UI element can be recycled with the same identifier. Prefer a unique request ID/text, a before/after value difference, and correlated source-derived Logcat events. Use the freshness option selectively because it adds a pre-action UI observation. Plain existence checks remain inexpensive.

## Async command output

`feedback.mjs exec` checks explicitly structured stdout from child wrappers. A child returning exit code 0 with `{"state":"running","exit_code":null}` or similar nonterminal status is classified `ASYNC_NOT_COMPLETED` and marked `INCONCLUSIVE`. The Agent must wait for that tool's actual completion and save its terminal result as **another recorded Attempt**. Bare command exit 0 without a terminal child report is not proof that asynchronously detached work completed. Report this limitation clearly; unknown opaque background work cannot be detected automatically.

## Feedback size priorities

`feedback.zip` now prioritizes `summary.md`, `manifest.json`, `timeline.jsonl`, `index.json`, three Gate files, impact/oracle plans, test discovery and **all** per-attempt `attempt.json` metadata before raw screenshots/Logcat. `zip-manifest.json` indicates complete/incomplete packaging and the included/omitted paths; `zip-omissions.txt` details the omissions. Large raw evidence remains in the local directory. Do not claim independent verification if essential files are unavailable or the ZIP is marked `incomplete`.
