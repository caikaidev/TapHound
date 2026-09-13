# Agent Integration (V1.0)

The final Coding-Agent interface is deliberately tiny. An agent does not need
to understand TapHound's internals — it only needs a finish condition:

> **TapHound Verdict == PASS**

It is designed for Coding Agents (Claude Code, other terminal agents, and CI
pipelines alike): every response is one machine-readable JSON value, commands
are single-entry, and no TapHound internals leak into the agent's context.

## Stable CLI invocation contract

Every machine-readable command follows one rule:

```text
exactly one JSON value on stdout
progress + diagnostics on stderr
JSON exitCode == process exit code
```

- `taphound verify --contract <path> --json` emits the Verdict (with
  `exitCode`) as the only **stdout** value.
- `taphound verify --diff <ref> --json` emits `{overall, results, impact}`.
- `taphound failure classify --report <path> --json` emits the classification.
- `taphound knowledge feature-map --json` emits the projection.
- Non-JSON (human) mode writes summaries to **stdout** and errors to
  **stderr**, and sets the same exit code.

`taphound init` installs the two bundled Skills
(`taphound-journey-brief-author`, `taphound-journey-generator`) into
`assets/skills/`; `generation observe`/`next`/`step` drive one deterministic
generation session. bridge steps use External Flows; an escaped package that
never returns fails with `PACKAGE_ESCAPE` equivalent codes
(`BRIDGE_NOT_RETURNED`). The whole surface is exercised by
`verify-changes`/`verify --diff` against registered targets or worktrees, and
`taphound init` is the recommended first install step for agents.

## The single entry point

```bash
# verify everything a Git change affects (minimal verification set)
taphound verify --diff main --project /path/to/android-project --json

# or an explicit base/head
taphound verify --diff origin/main --base main --head HEAD --scope p0,p1

# or a bare Journey / Acceptance Contract
taphound verify --journey .taphound/journeys/search.json --json
taphound verify --contract .taphound/contracts/search.json --json
```

`verify --diff <ref>` is the diff-aware entry (V1.0): it computes
`git diff <ref>...HEAD`, maps the change through Project Context + Knowledge
(`impact`), selects the affected Journeys (P0/P1/P2), replays each, and
returns one `overall` verdict:

```json
{
  "base": "origin/main",
  "head": "HEAD",
  "impact": { "...": "see docs/impact.md" },
  "results": [
    { "path": ".taphound/journeys/search.json", "name": "TapHound demo search", "selection": "p0", "status": "passed", "reportPath": "..." }
  ],
  "overall": "passed"
}
```

The Coding Agent's loop:

```text
agent: "implemented the change"
taphound verify --diff main     → overall: passed  → Task Done
                                  overall: failed  → agent reads failure classify →
                                                      fixes → re-run
```

## Failure handling

When a Journey fails, the agent consumes `failure classify` (structured
contract) — never raw logcat:

```bash
taphound failure classify --report <run>/report.json --json
```

## Local targets (`--target`)

Register a repo once, then let the agent target it by id:

```bash
taphound local add my-app --path /path/to/repo
taphound verify --diff main --target my-app --json
```

This works in a **worktree** (head = `WORKTREE`): the change set is computed
against the target's Git root while the app builds in the worktree.

## Verdicts and Source of Truth

`overall` is deterministic: every selected Journey must `pass`. A `failed`
Journey is never rewritten to `pass` by a reviewer, semantic comparator, or
multimodal layer (see `docs/source-of-truth.md`). Only `contract review`
can escalate `pass`/`inconclusive` to `needsReview`, and the Escalation
Policy decides deterministic escalation triggers (`docs/playbook.md`).

## Suggested Skill surface

A TapHound Agent Skill ships the following public commands (external to Core):

| Command | Purpose |
|---|---|
| `taphound verify --diff <ref>` | verify the minimal set a change affects |
| `taphound verify --contract <path>` | verify one task against its Acceptance Contract |
| `taphound failure classify --report <path>` | structured failure contract |
| `taphound knowledge feature-map --markdown` | low-token app map for orientation |
| `taphound baseline compare --baseline <path> --report <path>` | behavior regression check |

The Skill never mutates device state or Knowledge; it reads CLI JSON output
and orchestrates re-runs.

## Journey Brief Authoring (subagent dispatch)

`taphound-journey-brief-author` is the recommended producer of a Journey Brief:
it builds the Project Context Bundle (root index + one shard per Gradle
module) from read-only `taphound project`/`context` evidence, then authors one
Brief per Case by combining source analysis with read-only `taphound
observe`. A dispatcher (e.g. a Claude Code subagent dispatch) may parallelize
the authoring across Cases. The dispatch contract is the input envelope
`{project, caseGoal, caseId, contextPaths, observeSnapshot, output}` — the
`observeSnapshot` field carries the read-only observation evidence from
`taphound observe` that the author folds into the Brief. The author's working
artifacts are `plan.md` (the per-Case authoring plan) and
`requirement.md`-style case input; both stay project-relative. The author role
prompt ships as
`assets/skills/taphound-journey-brief-author/prompts/brief-author-role.md`
(plus a zh-CN variant). The Brief author uses only read-only commands and
never modifies device state.

## Journey Brief contract (Skills)

The `taphound-journey-generator` Skill consumes an optional project-relative
**Journey Brief** through a `journeyBrief: {path, sha256}` binding in its
invocation. The Brief is a hook to the `taphound-journey-brief.md` contract
(`assets/skills/taphound-journey-generator/templates/`): the generator's
`consume-journey-brief` prompt reads Goal, Preconditions, Expected Journey,
Assertions, Implementation Hints, Constraints, Evidence References, State
Transition Map, and Capability Notes into the deterministic generation flow.
It is **untrusted static Case context** — Core never executes it; Project
Context, live Runtime Snapshots, risk policy, execution, and final Replay stay
authoritative. The hash binding (`journeyBrief.sha256`) lets a caller detect a
stale brief before generation.