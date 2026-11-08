# TapHound Skills v3.6 · Copy Ready

This is the **default** TapHound workflow. Run `taphound init --agent codex`
(or another supported Agent) to install the three Field Skills. They also
remain **direct-copy**: no installer, CLI or extra npm dependency is required
to run them after copying the three sibling directories into an Agent's
Skills directory:

```text
.agents/skills/                  # Codex (project-scoped)
├── tap-check/                   # Verify new requirement + preserve related behavior
├── tap-fix/                     # Reproduce bug, fix, RED/GREEN, regressions
└── taphound-flash/              # Mobile MCP → Appium → ADB; evidence & feedback
    ├── SKILL.md
    ├── scripts/
    │   ├── feedback.mjs
    │   ├── field-runner.mjs
    │   ├── flash.mjs
    │   ├── oracle-review.mjs
    │   ├── feedback-pack-policy.mjs
    │   └── ...
    ├── references/
    │   └── v36-oracle-evidence.md
    └── templates/
        └── oracle-review.example.json
```

Use `.claude/skills/`, `.cursor/skills/`, or `.factory/skills/` for other supported Agents. Back up local customizations before replacing same-named directories, then
reload the Agent. If the agent directory already contains the original
`taphound-verify-change`, `taphound-bug-fix` or other legacy-profile Skills,
move them **outside** that Skills directory first. The CLI installer fails
closed on incompatible profiles instead of silently merging two different
`taphound-flash` implementations. Legacy installation remains available via
`taphound init --agent codex --profile legacy`. The `tests/` directory and this README are optional and need not be copied into the Agent's skill root.

## Invocation

- **“验收一下本次修改”** or **“用 tap-check 验收”** → target behavior + existing tests + impacted B…N regressions.
- **“复现并修复这个 Bug”** or **“用 tap-fix 修复”** → confirmed RED, same-oracle GREEN, existing tests + B…N regressions.
- **“快速冒烟一下”** → `taphound-flash` only.

Auto-trigger is decided by the coding Agent; explicitly naming the Skill is more reliable.

## v3.6 changes (based on v3.5 field feedback)

1. **Fast Oracle review without routine user prompts.** Before target/regression green gates, Agent reads the task/bug report, local old tests and the relevant handler → ViewModel/state/data chain, writes a concise source-backed `oracle-review.json`, then runs `feedback.mjs oracle --dir ... --file ...`. The review is versioned; later changes invalidate previously green target/regression gates. If a necessary expectation is ambiguous, `INCONCLUSIVE` rather than fake success. No fourth user approval Gate. See `taphound-flash/references/v36-oracle-evidence.md`.
2. **Fresh-result check when needed.** A positive UI `expect` may specify `"newSinceAction":true`: it observes the target *before* the preceding tap/type/back, then asserts it appears afterward. It refuses old AI messages/result cards that were already present. This is optional and does not itself prove causality unless combined with a unique result or correlated Logcat.
3. **Critical-first feedback.zip.** The prior ZIP packed files alphabetically, so large logs could displace `summary.md`, Gate JSON, timelines and the final Attempt. v3.6 retains essential metadata first, then raw evidence. `zip-manifest.json` records completeness and omitted paths; bulk logs/screenshots stay locally if over the size budget. A missing essential file is an archive error.
4. **Async completion recognition.** If `feedback.mjs exec` runs a wrapper that exits 0 but prints a structured nonterminal result such as `{"state":"running","exit_code":null}`, the Attempt is `INCONCLUSIVE` / `ASYNC_NOT_COMPLETED`. Agent must record the actual completed command in a new Attempt before any green gate. Opaque detached processes cannot be detected generically.
5. **Non-exported Android Activity startup fallback.** Flash can recover to the package Launcher if explicit `am start` is denied due to a non-exported Activity. `"launchMode":"launcher"` can be used explicitly to avoid a direct internal Activity launch. Appium likewise retries creation without `appActivity` on a recognized export denial. Device serial binding remains unchanged.

## Preserved from v3.5

- Mobile MCP first for UI; Appium next, ADB fallback. ADB on the **same selected serial** is the sidecar for source-derived Logcat, Crash and APK evidence.
- Exactly one selected device per case; never fall back to another. The PATH-based ADB guard is best-effort, not an OS sandbox.
- Target / Existing Tests / Regression **three mandatory evidence-backed gates**; related unit tests require real JUnit XML / TAP counts. Impact plans and test-discovery inventory remain versioned.
- RED and GREEN in `tap-fix` must retain identical frozen test scripts and expectations; modifying the test can be explained, but cannot silently count as FIXED.
- Every Attempt saves its plan, command, stdout/stderr, test oracles, Git state, APK metadata (when accessible), UI and Logcat evidence (when applicable).

## Minimal journal example

```bash
JOURNAL='<absolute skill-root>/taphound-flash/scripts/feedback.mjs'
FB='.taphound/feedback/<unique-case-id>'
node "$JOURNAL" start --dir "$FB" --skill tap-check --task '验收本次修改' --device SERIAL
node "$JOURNAL" impact --dir "$FB" --file .taphound/build/field-tests/<case>/impact-plan.json
node "$JOURNAL" discover --dir "$FB" --project "$PWD"
node "$JOURNAL" oracle --dir "$FB" --file .taphound/build/field-tests/<case>/oracle-review.json
node "$JOURNAL" run --dir "$FB" --backend auto --device SERIAL --plan .taphound/build/field-tests/<case>/target-plan.json
# Agent executes old unit tests and impacted regression scenarios as separate journal attempts,
# registers all three gates with actual evidence, then calls finish PASS/FIXED.
node "$JOURNAL" status --dir "$FB"
```

The above **is not a one-command success shortcut**. See `tap-check/SKILL.md`, `tap-fix/SKILL.md`, `taphound-flash/references/feedback-workflow.md` and `v36-oracle-evidence.md` for exact gate commands and rules.

## Test & handoff

The optional synthetic suite runs on Node.js 22+:

```bash
node --test tests/*.test.mjs
```

These tests validate local logic and simulated Mobile MCP; they **do not certify real Android, Appium or Mobile MCP behavior**. The Agent should provide `<project>/.taphound/feedback/<case-id>/feedback.zip` even for failures. Inspect `zip-manifest.json` for `status: complete`; a ZIP with omitted bulky screenshots or logs can remain structurally complete, but omitted material may still limit independent proof of a behavior. Never claim untested related scenarios are safe. Review/redact private messages, tokens, credentials, user data, source secrets, APK metadata and screenshots before sharing.
