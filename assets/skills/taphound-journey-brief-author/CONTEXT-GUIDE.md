# TapHound Context Author Usage Guide

This guide describes how to use an AI agent (Droid, Claude Code, Cursor,
etc.) to generate and maintain a TapHound Project Context Bundle for an
Android project.

## Architecture Overview

```
User requests Context generation or update
        |
        v
+-----------------------------+
|  One-time setup (first run   |
|  or after major changes)     |
|  AI analyzes source ->       |
|  Project Context Bundle      |
|  taphound context validate   |
+-------------+---------------+
              | Context reused
              v
+-----------------------------+
|  Consumed by downstream      |
|  skills (do not own Context):|
|  - taphound-journey-generator       |
|  - taphound-journey-brief-   |
|    author                    |
+-----------------------------+
```

Project Context is generated once and reused. It only needs regeneration
when the project source changes significantly (see Section 5). The
downstream Skills (`taphound-journey-generator`, `taphound-journey-brief-author`)
require a valid Context and stop with an error when they encounter a stale
or invalid one — they never generate or repair Context themselves.

---

## 1. Prerequisites

### 1.1 Environment Requirements

| Item | Requirement |
|------|-------------|
| Node.js | 22+ (avoid 23) |
| Android SDK | ADB (for `doctor` environment validation) |
| Device | NOT required for Context generation |
| App | Target APK already installed (for downstream Skills, not for this one) |
| TapHound | Cloned repo with `npm ci` installed |

### 1.2 Build TapHound

```bash
cd /path/to/TapHound
npm ci
npm run build
npm link          # Register global taphound command
```

Verify the registration:

```bash
taphound --help
```

Should output `Usage: taphound` and list `doctor`, `context`, `project`
commands (among others).

> If you prefer not to register globally, you can use `npx taphound` or
> `node dist/cli/main.js` in place of `taphound` throughout this guide.

### 1.3 Environment Diagnostics

```bash
taphound doctor \
  --project /path/to/android-project \
  --json
```

A device is NOT required for Context work. If `doctor` reports
`DEVICE_UNAVAILABLE`, that is acceptable for `context generate` and
`context refresh`. Confirm other checks pass.

---

## 2. One-Time Setup: Generate Project Context

> Project Context describes the Android project's UI structure, element
> locators, and interaction policy. It is generated once, persisted in the
> project directory, and reused for every Journey generation and Brief
> authoring run. Only significant source changes require regeneration
> (see Section 5).

### 2.1 Load the Skill in Your AI Agent

Run `taphound init` to install the Skill into each agent's expected directory,
then load it in your AI agent tool. The entry file is `SKILL.md`. The method
depends on the tool:

- **Droid**: The Skill is auto-discovered from `.factory/skills/` in the
  TapHound repo. Run `taphound init --agent droid` in other projects.
  Invoke it with the Skill tool using `taphound-journey-brief-author`.
- **Claude Code**: Run `taphound init --agent claude` to install to
  `.claude/skills/`, then invoke with the Skill tool.
- **Codex**: Run `taphound init --agent codex` to install to `.agents/skills/`.
- **Cursor**: Run `taphound init --agent cursor` to install to `.cursor/skills/`.
- **Other tools**: Run `taphound init --agent other` to install to
  `.agents/skills/`, or have the agent read `SKILL.md` directly.

### 2.2 Have the AI Analyze Project Source

Tell the AI agent (after the Skill is loaded, just provide the project
path):

```
Generate a TapHound Project Context for the project at /path/to/android-project.
```

The AI agent will follow SKILL.md Phase 1 instructions and automatically
perform these steps:

1. Run `taphound context generate --project <project> --json` to discover
   all modules (Core parses `settings.gradle`, falls back to filesystem
   scanning), and identify the app module (the one with `applicationId`).
2. Read `applicationId` from the app module's `build.gradle` or
   `build.gradle.kts` as the package name (Core resolves this; falls back
   to the `package` attribute in the manifest for legacy projects).
3. Identify the launch Activity from the app module's `AndroidManifest.xml`
   (library module Activities are merged in via manifest merge).
4. Analyze each module independently for Activities, click handlers, Logcat
   tags, navigation, and layouts. Write one shard under
   `.taphound/context/modules/` before moving to the next module.
5. Store reusable screen, element, transition, and Logcat semantics in each
   shard. Core computes evidence hashes and the module inventory path-set
   hash.
6. Mark every discovered module `complete`, `partial`, `unsupported`, or
   `notAnalyzed`; never silently omit a module because the project is large.
7. Hash each completed shard and write the compact root index matching
   `schemas/project-context.json`.

> **Multi-module note**: Activities may be distributed across library/feature
> modules, and layout XML may be in any module's `res/layout/`. The AI agent
> uses Core's module discovery to get the authoritative module list. The
> root index stays small; detailed semantics are loaded from selected
> shards.

### 2.3 Write and Validate Context

The AI-generated Bundle is written to:

```
<project>/.taphound/context/
├── project-context.json
└── modules/
    ├── app.json
    └── feature-search.json
```

Then validate:

```bash
taphound context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

**Success**: `"status": "valid"`, exit 0. Context is ready.

**Failure**: Fix based on the error message. Common causes:

| Error | Cause | Fix |
|-------|-------|-----|
| `CONTEXT_INVALID` | Package name / Activity mismatch | Check against AndroidManifest.xml |
| `CONTEXT_INVALID` | Incorrect SHA-256 | Run `context rehash` |
| `CONTEXT_INVALID` | Path contains `..` or starts with `/` | Use project-relative paths |
| `CONTEXT_STALE` | File content does not match hash | Source changed, run `context refresh` or rehash |

### 2.4 Check Context Status (Optional)

You can check whether the Context is still valid at any time:

```bash
taphound context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

Returns `"valid"` (still valid), `"stale"` (files changed, needs update),
or `"invalid"` (structural error).

List the compact module catalog without loading all shards:

```bash
taphound context list \
  --project /path/to/android-project \
  --context .taphound/context/project-context.json \
  --json
```

### 2.5 Context Persistence

The generated `project-context.json` is saved in the project's
`.taphound/context/` directory. This file can be:

- **Committed to Git**: If the project source is stable, the Context can
  be tracked as a project artifact.
- **Added to .gitignore**: If the project changes frequently, regenerate
  dynamically before each run.

Recommendation: commit to Git after first generation, update per Section 5
when source changes.

---

## 3. Full Regeneration (Structural Changes)

When a new Gradle module is added or the Bundle is `invalid`, update the
module catalog and generate only missing or invalid shards:

1. Have the AI agent re-analyze the source (reads `prompts/analyze-project.md`)
2. Run `context generate --force` to overwrite the existing Context:
   ```bash
   taphound context generate \
     --project /path/to/android-project \
     --force \
     --json
   ```
3. Re-discover all modules via Core (parses `settings.gradle`)
4. Add every discovered module to the root index with explicit status
5. Generate each new/invalid module shard independently (Section 2.2 steps 4–6)
6. Recompute affected shard hashes and global interaction policy
7. Rewrite the root index
8. Validate with `context validate`

```bash
# In the AI agent:
# "Regenerate the TapHound Project Context for /path/to/android-project.
#  The source has been updated with new screens and layouts.
#  Run a full re-analysis per prompts/analyze-project.md."

taphound context validate \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

---

## 4. Complete Example: Generating Context for the Demo Project

Using `examples/taphound-android-demo` as the project.

```bash
# In the AI agent:
# "Generate a TapHound Project Context for examples/taphound-android-demo"
# AI analyzes source and generates:
# examples/taphound-android-demo/.taphound/context/project-context.json

# Validate
taphound context validate \
  --project examples/taphound-android-demo \
  --context .taphound/context/project-context.json \
  --json
```

The Context is now ready for downstream Skills (`taphound-journey-generator`,
`taphound-journey-brief-author`) to consume.

---

## 5. Updating Project Context

Android projects evolve continuously: buttons are added, layouts are
restructured, Activities come and go. The Context needs to track these
changes to remain useful for staleness detection and interaction policy.

There are three levels of update, from lightest to heaviest:

### 5.1 Pre-Session Check (Before Every Downstream Skill Run)

Run this before each Journey generation or Brief authoring session to
decide which update level is needed.

**Step 1: Hash staleness check**

```bash
taphound context status \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

- `"valid"`: All tracked file hashes match. Proceed to Step 2.
- `"stale"`: Some tracked files changed. Needs at least an incremental
  update (Section 5.2).
- `"invalid"`: Context structure is broken. Needs full regeneration
  (Section 3).

**Step 2: Module completeness check**

Module inventory path-set hashes include manifest, source, layout, and
navigation paths. `context status` therefore detects files added or removed
inside an existing module. Root project evidence detects changes to the
Gradle module catalog. Also run `context list --json` and ensure every module
is explicitly `complete`; `partial`, `unsupported`, and `notAnalyzed` are
coverage gaps, not successful full generation.

**Decision matrix:**

| `context status` | Module catalog | Action |
|------------------|----------------|--------|
| `valid` | All selected modules complete | Context is current. Proceed. |
| `valid` | Any module incomplete | Complete that module shard |
| `stale` | Existing module changed | Run `context refresh --json`, then act on each block's `resolution` (see 5.2) |
| `stale` | Module catalog changed | Update index and generate new shards (Section 3) |
| `invalid` | — | Repair or regenerate Bundle (Section 3) |

### 5.2 Incremental Update (Content-Only Changes)

**Step 0: Hash-only refresh**

Before any re-analysis, let TapHound recompute hashes:

```bash
taphound context refresh \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --json
```

- `"refreshed"` / `"unchanged"`: nothing semantic changed. `semanticSha256`
  values are backfilled, formatting- or comment-only edits are rehashed,
  drifted shard hashes in the index are repaired, and the Context is current.
- `"blocked"`: the response lists the modules and files that changed
  semantically, whose inventory changed, or whose evidence is missing. Each
  block carries a `resolution` field — act on it, do not blanket re-analyze:

  | block `code` | `resolution` | Action |
  |---|---|---|
  | `EVIDENCE_UNRESOLVED` | `pruneDeleted` | A tracked file was deleted. Re-run with `--prune-deleted` (drops the entry). Combine with `--accept-source-changes` if inventory also drifted. |
  | `EVIDENCE_SEMANTIC_CHANGED` | `acceptSourceChanges` | A tracked file's semantics changed. Re-run with `--accept-source-changes` to rehash. Re-analyze (below) only if the module summary is now wrong. |
  | `MODULE_INVENTORY_CHANGED` | `acceptSourceChanges` | The on-disk file set grew or shrank. Re-run with `--accept-source-changes` to accept the new inventory hash. Re-analyze only when new UI files were added that the summary must cover. |
  | `EVIDENCE_UNRESOLVED` | `reanalyze` | An evidence file is unreadable/escaped/too large (not a clean deletion). Fix the file or regenerate that module's shard (below). |

The typical one-shot reconcile for routine edits + deletions:

```bash
taphound context refresh \
  --project /path/to/android-project \
  --context /path/to/android-project/.taphound/context/project-context.json \
  --prune-deleted --accept-source-changes --json
```

`--module <id...>` narrows the scope. `--accept-source-changes` rehashes
semantic and inventory drift; use it only after confirming the recorded module
summary (screens, elements, transitions, Logcat) is still accurate, because
`refresh` never updates semantics. `--prune-deleted` only drops entries for
files that are truly gone (`notFound`); unreadable or escaped files stay
blocked as `reanalyze`.

When a block's `resolution` is `reanalyze`, or when `acceptSourceChanges`
would hide newly added UI screens the Goal may reach, regenerate the affected
module shards instead of reanalyzing unrelated features:

1. Identify which files changed (the `context status` output lists them).
2. Recompute SHA-256 for each changed file.
3. If any changed file is an Activity source, re-read it to check for:
   - New Logcat tags (affects `expect` candidates)
   - New click handlers or input fields (affects `interactionPolicy`)
   - New `startActivity` calls (affects navigation understanding)
4. If any changed file is a layout XML, re-read it to check for:
   - New `android:id` elements (new locator candidates)
   - Removed elements (locators that no longer exist)
   - Changed `android:text` or `android:contentDescription`
5. Update shard semantics, evidence, and inventory. Write the shard,
   recompute its file hash, and update the root index reference.
6. Update the global `interactionPolicy` only when needed, then validate:
   ```bash
   taphound context validate \
     --project /path/to/android-project \
     --context /path/to/android-project/.taphound/context/project-context.json \
     --json
   ```

This is fast because it only touches changed files, not the entire
project.

### 5.3 Signs of Stale Context During Downstream Generation

Sometimes the pre-session check passes but the Context is still outdated
(e.g., a layout's content changed without changing the file count). The
downstream Skills may encounter these signs during generation:

| Sign | Likely cause | Action |
|------|-------------|--------|
| `observe` shows elements not expected from Context | Layout changed (new elements) | Continue if the element is actionable; update Context after session |
| `observe` shows a different Activity than expected | New Activity added or navigation changed | Re-observe and adapt; update Context after session |
| `LOCATOR_NOT_FOUND` for an element that should exist | Element was removed or `android:id` changed | Re-observe, try alternative locator; update Context after session |
| `LOCATOR_AMBIGUOUS` for a previously unique element | Duplicate ID added in another layout | Use more specific locator; update Context after session |
| Logcat expectation fails | Log tag or message pattern changed | Check source, update expectation; update Context after session |

> When any of these signs appear, the downstream Skill should note the
> discrepancy and recommend running this Skill (`taphound-journey-brief-author`)
> to update the Context after the session completes. It should NOT abort
> the session unless the error is unrecoverable.

### 5.4 When to Update

| Change type | Update level |
|-------------|-------------|
| Modified button text or content description | Incremental (re-hash) |
| Modified click handler logic | Incremental (re-hash, check Logcat tags) |
| Added/removed `android:id` in existing layout | Incremental (re-hash) |
| Added new Activity | Full regeneration |
| Removed Activity | Full regeneration |
| Added/removed layout XML file | Full regeneration |
| New module added (`settings.gradle` changed) | Full regeneration |
| Changed `applicationId` | Full regeneration |
| Modified `<include>`/`<merge>` structure | Incremental (re-hash) |
| Modified business logic but UI unchanged | Incremental (re-hash only) |
| Modified themes/styles | No update needed |
| Modified Gradle dependency versions | No update needed (unless package name changed) |

---

## 6. Failure Troubleshooting

### 6.1 context generate Failures

| Error | Cause | Fix |
|-------|-------|-----|
| `CONFIG_INVALID` | `.taphound/config.json` missing or invalid | Run `taphound init` first, or fix config |
| Module discovery fails | `settings.gradle` not found | Ensure project root is correct |
| `applicationId` not found | Build file missing or malformed | Check `build.gradle(.kts)` |

### 6.2 context validate Failures

| Error | Cause | Fix |
|-------|-------|-----|
| `CONTEXT_INVALID` | Package name / Activity mismatch | Check against AndroidManifest.xml |
| `CONTEXT_INVALID` | Incorrect SHA-256 | Run `context rehash` |
| `CONTEXT_INVALID` | Path contains `..` or starts with `/` | Use project-relative paths |
| `CONTEXT_STALE` | File content does not match hash | Source changed, run `context refresh` |

### 6.3 context refresh Failures

| Error | Cause | Fix |
|-------|-------|-----|
| `blocked` with `reanalyze` | Evidence file unreadable/escaped | Fix file or regenerate shard |
| `blocked` with `MODULE_INVENTORY_CHANGED` | Files added or removed | Run with `--accept-source-changes`, or re-analyze if new UI files |

---

## 7. Safety Constraints

- The AI agent NEVER computes SHA-256 hashes manually. Core does all
  hashing via `context generate`, `context rehash`, and `context refresh`.
- The AI agent NEVER discovers modules manually. Core parses
  `settings.gradle` and falls back to filesystem scanning.
- The AI agent NEVER resolves `applicationId` or launch Activity manually.
  Core inspects build files and manifests.
- This Skill does NOT modify device state. It does NOT use `generation`,
  `verify`, `record`, `observe`, or `align`.
- The generated Context is the authoritative input for downstream Skills.
  A stale or invalid Context stops Journey generation and Brief authoring.
- Real-device acceptance is fully separate from the normal test suite and
  does NOT run in `npm test`.
