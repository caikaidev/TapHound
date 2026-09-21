---
name: taphound-case-suite
description: >-
  Persist and orchestrate a multi-Case TapHound Journey generation suite.
  Freezes the user-approved Case catalog, maintains an atomic revisioned
  Case Ledger and human-readable status, plans verified Base Flow reuse,
  and dispatches exactly one Case at a time to the Journey Brief Author
  and Journey Generator Skills. Use when a regression plan contains
  multiple Cases or must survive context compaction, agent restart, or
  interrupted generation sessions.
compatibility: >-
  Requires Node.js 22+, TapHound's taphound-journey-brief-author and
  taphound-journey-generator Skills, and the public TapHound CLI.
metadata:
  author: TapHound
  version: "1.0"
---

# TapHound Case Suite

This Workflow Skill owns durable **multi-Case orchestration**. It never
executes a Journey step itself and never reads or writes Core generation
bundles. It dispatches one Case at a time to:

- `taphound-journey-brief-author` for one Case Brief;
- `taphound-journey-generator` for one generation session and final Replay.

The Case catalog and Ledger on disk are the Source of Truth. Chat history is
not a requirement store. Never reconstruct missing Cases from memory,
resource IDs, source hints, or a prior conversation summary.

## Skill payload

All paths below are relative to this installed Skill:

```text
taphound-case-suite/
├── SKILL.md
├── scripts/ledger.mjs
├── schemas/
│   ├── suite-input.schema.json
│   ├── case-catalog.schema.json
│   ├── case-ledger.schema.json
│   ├── transition.schema.json
│   └── base-flow-record.schema.json
└── templates/
    ├── suite-input.example.json
    ├── transition.example.json
    └── base-flow-record.example.json
```

Use `node <skill>/scripts/ledger.mjs help` for the helper contract.

## Durable suite directory

The caller chooses an explicit project-relative suite directory. A normal
layout is:

```text
doc/development/<suite-id>/
├── cases.json          # frozen user-approved Case catalog
├── case-ledger.json    # mutable, revisioned orchestration state
├── STATUS.md           # generated human view; never the Source of Truth
└── briefs/
    └── <case-id>/taphound-journey-brief.md
```

`cases.json` is immutable after initialization. To change requirements,
archive the old Suite and initialize a new Suite ID. Do not edit
`case-ledger.json` or `STATUS.md` by hand; use the helper so revision checks,
transition rules, hashes, and the single-active-Case invariant are enforced.

The suite directory is committed project material. Runtime reports and
generation bundles remain under `.taphound/build/` and may be referenced by
path and hash, but raw Logcat, screenshots, captured values, credentials, and
personal data must never be copied into the catalog or Ledger.

## Phase 0: Freeze the Case catalog

Require the complete user-approved Case list before execution. Each Case needs:

- stable `id`;
- explicit `order`;
- title;
- exact `sourceText` preserving the user's requirement;
- `risk`: `readOnly`, `stateChanging`, or `external`;
- dependency Case IDs;
- optional planned Base Flow name.

If the original list is unavailable, a source-derived proposal is allowed only
as a draft presented to the user. Initialize the Suite only after approval.
Never silently fill gaps.

Create an input from `templates/suite-input.example.json`, then:

```bash
node <skill>/scripts/ledger.mjs init \
  --input /tmp/taphound-suite-input.json \
  --out <project>/doc/development/<suite-id>
```

Initialization canonicalizes `projectRoot`, validates dependency cycles and
ordering, writes the frozen catalog, records its exact-byte SHA-256 in the
Ledger, and creates `STATUS.md`. Existing suite files are never overwritten.

## Phase 1: Resume from disk

At the start of every agent invocation, including after context compaction:

```bash
node <skill>/scripts/ledger.mjs validate --suite <suite-directory>
node <skill>/scripts/ledger.mjs status --suite <suite-directory>
```

Then:

1. Read `cases.json` and `case-ledger.json`.
2. If one Case is nonterminal and not `pending`, resume that Case first.
3. Reconcile a stored `generationId` with:
   ```bash
   taphound generation status \
     --project <project> --session <generationId> --json
   ```
4. Follow the recorded `nextAction`; never infer that an interrupted action is
   safe to repeat.
5. Only when no Case is active, select the lowest-order eligible `pending`
   Case whose dependencies are `verified`.

The helper uses optimistic concurrency. Every transition requires the current
`expectedRevision`; a stale agent fails instead of overwriting newer work.
If an agent process was killed while holding the short-lived helper lock,
first confirm no update process is running, then use:

```bash
node <skill>/scripts/ledger.mjs recover-lock --suite <suite-directory>
```

The helper removes the lock only when its recorded local PID no longer exists;
it never breaks a live writer's lock.

## Phase 2: Plan order and Base Flows

Order Cases by deterministic prerequisites, not by convenience:

1. stable cold-launch and entry coverage;
2. shallow read-only Cases;
3. same-page controls and navigation;
4. asynchronous/WebView Cases;
5. state-changing Cases;
6. external/cross-package Cases.

Keep user-declared `order` authoritative. Dependencies may delay a Case, but
the Skill must not reorder or rewrite the catalog silently.

Cluster Cases by repeated navigation prefix. A Base Flow is eligible only when:

- it begins at a stable Activity reachable after cold launch;
- it contains only shared deterministic navigation;
- it contains no Case-specific business action or assertion;
- its Activity boundaries compose exactly;
- a Journey Source that includes the Flow was resolved;
- the resolution manifest binds the exact Flow hash and resolved Journey hash;
- an independent Replay of that resolved Journey passed;
- all file and report hashes are recorded in the Ledger.

Record a verified Flow:

```bash
node <skill>/scripts/ledger.mjs record-flow \
  --suite <suite-directory> \
  --input /tmp/taphound-flow-record.json
```

Use `templates/base-flow-record.example.json`. The helper validates the Flow
name/file, resolution manifest, resolved Journey, exact hashes, passed report,
project confinement, and revision.
Never modify a bound Flow while a generation session is active.

## Phase 3: One Case at a time

The device policy is serial. On one device, never run two active Cases or two
generation sessions concurrently. Separate devices are outside v1; initialize
separate Suites instead of bypassing this invariant.

### 3.1 Claim

Transition the selected Case:

```text
pending → briefing
```

Use `templates/transition.example.json` and:

```bash
node <skill>/scripts/ledger.mjs transition \
  --suite <suite-directory> \
  --input /tmp/taphound-transition.json
```

### 3.2 Brief

Dispatch exactly one Case to `taphound-journey-brief-author` with:

- `caseId`;
- exact catalog `sourceText` as `caseGoal`;
- explicit context paths only;
- output
  `<suite>/briefs/<case-id>/taphound-journey-brief.md`.

After authoring, compute its exact hash and transition:

```text
briefing → briefReady
```

The transition must carry `brief: {path, sha256}`. Paths stored in the Ledger
are project-relative.

### 3.3 Generation

Before generation:

- ensure Project Context is valid;
- list Flows;
- if the Case plans a Base Flow, require the Ledger to contain the same Flow
  in `verified` state;
- pass the bound Brief path/hash to the Generator.

Start one session and transition:

```text
briefReady → generating
```

Record `generation: {id, baseFlow?}`. After every public CLI command, write the
new failure/next action to the Ledger before doing more work.

The Journey Generator remains authoritative for observe/step/confirmation,
`recover`, `reopen`, replacement, and finalization semantics.

### 3.4 Final Replay and independent Replay

After candidate steps are complete:

```text
generating → verificationPending
```

Run `generation finalize`. A generated Journey is not Suite-complete yet.
Run one independent standard `taphound verify` against the exported Journey
and strict generated Replay policy.

Only then transition:

```text
verificationPending → verified
```

The transition must provide:

- Journey path/hash;
- generation meta path/hash (`status: verified`);
- finalization report path/hash (`status: passed`);
- independent report path/hash (`status: passed`, different `runId`).

The helper reads and hashes all four artifacts. Agent prose, screenshots, a
successful last step, or a finalization report without independent Replay can
never mark a Case `verified`.

## Failure and recovery states

Allowed states:

```text
pending
briefing
briefReady
generating
recoveryRequired
verificationPending
verificationFailed
blocked
verified
archived
```

Important paths:

- interrupted action or verification:
  `generating|verificationPending → recoveryRequired`;
- deterministic final Replay failure:
  `verificationPending → verificationFailed`;
- tool/environment/context blocker:
  current state → `blocked`;
- user abandonment:
  nonterminal state → `archived`.

`recoveryRequired` must record `failure` and `nextAction`. Obtain explicit user
approval before Core `generation recover --decision retry`.
`verificationFailed` resumes only after audited `generation reopen`.
When entering `blocked`, the helper records the exact prior state; it may
resume only to that state. `verified` and `archived` are terminal.

One unresolved Case remains the Suite's current Case. Do not skip ahead merely
to make the completion count increase. Archive or resolve it explicitly.

## Completion and handoff

The Suite is complete only when every Case is `verified` or explicitly
`archived`. `STATUS.md` shows checkboxes and evidence links, but all automation
must read `case-ledger.json`.

To hand work to another Agent, provide only:

- absolute suite directory;
- project path if it is not already canonical in `cases.json`;
- device availability.

The receiving Agent validates and resumes from disk. It does not need the
previous conversation or a re-posted Case list.

## Hard rules

- Never use chat history as the only Case store.
- Never guess a missing Case.
- Never edit the frozen catalog after initialization.
- Never manually edit the Ledger or generated status.
- Never run two Cases on one device concurrently.
- Never auto-approve confirmation or recovery.
- Never call a Case done before finalization plus independent Replay.
- Never put raw Logcat, screenshots, captured values, secrets, or user content
  in Suite files.
- Never treat a Base Flow as verified without a passing independent report and
  recorded hashes.
- Never read or write `.taphound/build/generations` directly.
