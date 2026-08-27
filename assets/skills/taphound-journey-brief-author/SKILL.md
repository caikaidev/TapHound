---
name: taphound-journey-brief-author
description: >-
  Author a TapHound Journey Brief v2 for one Case by analyzing Android
  project source and read-only device observation. Produces a
  taphound-journey-brief.md with State Transition Map and Capability
  Notes, ready for the taphound-ai-journey skill to consume. Use when
  the user wants to create a journey brief, generate a brief skeleton,
  or prepare case context before journey generation.
compatibility: >-
  Requires Node.js 22+, Android SDK with ADB and uiautomator, one online
  Android device, TapHound built and linked, and a valid Project Context.
metadata:
  author: TapHound
  version: "1.0"
---

# TapHound Journey Brief Author Skill

Produce one Journey Brief v2 for a single Case by combining Android source
analysis with read-only device observation. The Brief is the untrusted static
handoff from the planning phase to the Journey generation phase. It reduces
broad source rediscovery but never weakens Core validation, live Snapshot
binding, risk policy, or final Replay.

This Skill is the **producer** of the Brief. The `taphound-ai-journey` skill
is the **consumer**. They communicate through a `{path, sha256}` binding.

## Skill Directory

All file references are relative to `assets/skills/taphound-journey-brief-author/`.
The directory contains `prompts/` (the self-contained subagent role prompt)
and `templates/` (the Brief v2 skeleton).

## How to Use This Skill

Run `taphound init --agent <ids>` to install. The Skill is installed alongside
`taphound-ai-journey` into each agent's skills directory.

### Two consumption modes

1. **Subagent dispatch (primary)**: Copy the full content of
   `prompts/brief-author-role.md` into the subagent's PROMPT configuration
   field. The orchestrator dispatches one task per Case with explicit
   inputs (see Inputs below). The subagent returns a structured JSON
   summary; the orchestrator never re-parses raw exploration content.

2. **Manual single-Case**: An agent loads this SKILL.md directly, follows
   the phases below, and produces one Brief.

### Relationship to the Journey Skill

```
Orchestrator (lean context)
  |
  ├── dispatches brief-author subagent
  |     inputs: {project, caseGoal, caseId?, contextPaths?, observeSnapshot?}
  |     output: {path, sha256, caseId, edgesVerified, edgesNeedsObservation}
  |
  ├── human Review (brief is an inspectable artifact)
  |
  └── dispatches journey subagent
        inputs: {project, goal, journeyBrief: {path, sha256}}
        output: {journeyPath, reportPath, verified}
```

## Inputs

| Parameter       | Required | Default                                          | Description                                      |
|-----------------|----------|--------------------------------------------------|--------------------------------------------------|
| project         | yes      | —                                                | Android project root path                        |
| caseGoal        | yes      | —                                                | One Case's test scenario (natural language)      |
| caseId          | no       | —                                                | Case identifier for frontmatter                  |
| contextPaths    | no       | —                                                | Explicit path array; orchestrator decides which docs |
| context         | no       | `.taphound/context/project-context.json`         | Project Context path (relative to project)       |
| observeSnapshot | no       | —                                                | Pre-captured `taphound observe --json` result    |
| device          | no       | doctor auto-selects                              | Device serial                                    |
| output          | no       | `.taphound/journeys/taphound-journey-brief.md`   | Brief output path (relative to project)          |

**Hard rule**: NEVER search for or assume files named `plan.md`,
`requirement.md`, or any convention. Read ONLY files the caller explicitly
passes via `contextPaths`. If no `contextPaths` are supplied, work from
`caseGoal` alone plus source code and Project Context.

## Output

The Skill writes a `taphound-journey-brief.md` at the `output` path and
returns a structured JSON summary:

```json
{
  "status": "authored",
  "caseId": "CASE-002",
  "path": ".taphound/journeys/taphound-journey-brief.md",
  "sha256": "<exact-byte-hash>",
  "edgesVerified": 2,
  "edgesNeedsObservation": 1
}
```

On failure:

```json
{
  "status": "failed",
  "caseId": "CASE-002",
  "failure": { "code": "...", "message": "..." }
}
```

## Phase 0: Preflight

Prerequisites: Node.js 22+ (avoid 23), Android SDK with ADB and
`uiautomator`, one online device, TapHound built and linked, and a valid
Project Context.

1. Verify `taphound` is available.
2. Run `taphound doctor --project <project> --json`. Confirm
   `"status": "passed"`. Capture `deviceSerial`.
3. Check Project Context currency:
   ```bash
   taphound context status \
     --project <project> \
     --context <context> --json
   ```
   - `"valid"`: Proceed to Phase 1.
   - `"stale"`: Run `context refresh --json` with appropriate flags. If
     the module summary is now wrong, re-analyze is needed (the Journey
     Skill's Phase 1), not this Skill's responsibility. Stop and report.
   - `"invalid"` or file missing: Stop and report. The Journey Skill's
     Phase 1 must run first to produce a valid Context.

## Phase 1: Case Analysis

> Read `prompts/brief-author-role.md` for the full procedure — it is the
> self-contained prompt used by the subagent. The summary below is for
> manual reference.

1. If `contextPaths` is provided, read ONLY those explicit files. Extract
   context relevant to `caseGoal`.
2. Read the Project Context root index. Select modules relevant to
   `caseGoal` using their `features`, `activities`, and `transitions`.
3. Read the selected module shards' `summary` objects.
4. Perform targeted source reading for Activities and layouts mentioned in
   the Case:
   - Kotlin/Java: map `setContentView` to Activity→layout, find click
     handlers, `Log.i/d` tags, `startActivity` calls.
   - Layout XML: extract `@+id/<name>` (bare = resourceId), `android:text`,
     `contentDescription`.
5. Build a draft State Transition Map:
   - Edges with clear source evidence → `confidence: source`
   - Inferred edges → `confidence: needs-observation`
6. Extract logcat tag candidates, locator candidates, and idempotency
   notes from source.

## Phase 2: Device Observation (read-only)

If `observeSnapshot` is provided by the orchestrator, use it directly. Do
NOT call `taphound observe` yourself (the orchestrator pre-captured it to
enable parallel brief authoring without device contention).

If `observeSnapshot` is NOT provided and a device is available, you may
run:
```bash
taphound observe --project <project> --device <serial> \
  --logcat-lines 200 --json
```

Verify:
1. `report.foreground.activity` matches the Project Context's
   `launchActivity`.
2. Search `report.layout[]` for the first `source` edge's locator element:
   - Match by `resourceId` → `text` → `contentDescription` priority.
   - Confirm element `enabled: true` and supports the target action
     (e.g., `clickable: true`).
3. Extract logcat tag patterns from `report.logcat[]` for Capability
   Notes.
4. Edges verifiable in the snapshot keep `source` confidence. Edges not
   verifiable remain `needs-observation`.

If no device is available and no snapshot is provided, skip this phase.
All edges retain their Phase 1 confidence.

## Phase 3: Author Brief

1. Use `templates/taphound-journey-brief.template.md` as the skeleton.
2. Fill frontmatter: `schemaVersion: 2`, `kind: taphound.journeyBrief`,
   `caseId` (if provided).
3. Fill all 9 required sections:
   - `# Goal`: from `caseGoal`.
   - `## Preconditions`: from `contextPaths` docs or default
     "independent cold launch".
   - `## Expected Journey`: numbered steps from the State Transition Map
     edge sequence.
   - `## State Transition Map`: Mermaid diagram + edge table with
     confidence and locator hints.
   - `## Capability Notes`: runtime variable capture, multi-field
     locators, logcat semantics.
   - `## Assertions`: from `contextPaths` docs and source analysis.
   - `## Implementation Hints`: resourceIds, module paths.
   - `## Constraints`: no coordinates, Final Replay must pass,
     idempotency notes.
   - `## Evidence References`: source file paths.
4. Write to the `output` path.
5. Compute SHA-256 via shell: `shasum -a 256 <file>`.
6. Return the structured JSON summary.

## Key Rules

- Use ONLY read-only commands: `observe`, `context list`, `context status`,
  `doctor`. NEVER use `generation`, `verify`, `record`, `align`.
- Do NOT modify device state (no clicks, no input, no swipes).
- NEVER search for or assume files named `plan.md`, `requirement.md`, or
  any convention. Read ONLY files passed via `contextPaths`.
- The Brief is untrusted output — phrase all claims as hints, not
  authoritative assertions.
- Output must pass validation by `consume-journey-brief.md` (9 sections,
  correct frontmatter).
- SHA-256 is ALWAYS computed via shell, never guessed.
- One Brief per Case (mirrors the Journey Skill's one-Goal-one-session).
- The agent does NOT modify TapHound Core source code.
