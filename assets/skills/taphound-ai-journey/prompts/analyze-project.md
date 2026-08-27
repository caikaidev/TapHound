# Analyze Android Project for TapHound Context

You are filling in the semantic `summary` fields of a TapHound Project Context
Bundle v2 that Core has already scaffolded. Core owns module discovery,
identity inspection (`packageName`, `launchActivity`), evidence and inventory
hashing, and atomic writes. Your job is to read Android source files and
populate the `summary` object in each generated shard.

## Workflow

1. **Generate the Context skeleton** (Core does all structural work):
   ```bash
   taphound context generate --project <project> --json
   ```
   Core discovers Gradle modules, resolves `applicationId` and launch
   Activity, computes evidence and inventory hashes, and writes one
   `notAnalyzed` shard per module with an empty `summary`. Use `--force`
   to overwrite an existing Context. Verify the reported `packageName` and
   `launchActivity` match the installed app.

2. **Read each generated shard** under `.taphound/context/modules/<module>.json`.
   Each shard already has `moduleId`, `projectDir`, `inventory`, `manifest`
   (with hashed evidence files), and an empty `summary`. The `manifest.files`
   list tells you exactly which source files Core tracked — scan those.

3. **Scan source files and fill `summary`** for each module (Steps 1–5 below).

4. **Update the root index** (`.taphound/context/project-context.json`):
   copy `features`, `activities`, and `status` from each shard into the
   corresponding module entry. Update `interactionPolicy` based on source
   evidence (Step 6).

5. **Rehash and validate**:
   ```bash
   taphound context rehash \
     --project <project> \
     --context .taphound/context/project-context.json --json
   taphound context validate \
     --project <project> \
     --context .taphound/context/project-context.json --json
   ```
   Core recomputes all shard and index hashes. If validation fails, fix the
   named index or shard and rehash again.

## Step 1: Scan Kotlin/Java Source

For each module, scan `src/main/java/` and `src/main/kotlin/` (and variant
source sets when applicable):

- Find `setContentView(R.layout.*)` to map each Activity to its layout.
- Find `findViewById<T>(R.id.*)` or view binding references
  (`binding.submitButton`) to identify interactive UI elements.
- Find `setOnClickListener`, `setOnCheckedChangeListener`,
  `setOnTouchListener`, etc. to determine which elements are actionable.
- Find `Log.i(tag, message)`, `Log.d(tag, ...)`, `Log.w(tag, ...)`, etc.
  to identify logcat tags and message patterns usable as expectations.
- Find `startActivity(Intent(this, TargetActivity::class.java))` or
  navigation component calls to predict Activity transitions.
- Find `EditText`, `TextView`, `Button`, `RecyclerView`, `ScrollView`
  usages to understand what actions each screen supports.

## Step 2: Scan Layout XML

Extract UI element information from `src/main/res/layout/` files:

- Extract `android:id="@+id/<name>"` — the `resourceId` for locators is
  the bare name (e.g., `open_search`, not `id/open_search`).
- Extract `android:text` and `android:contentDescription` as fallback
  locator identity fields.
- Note the widget type (Button, EditText, TextView, RecyclerView,
  ScrollView, etc.) to understand what actions each element supports.

### Complex layout structures

Real Android layouts use several composition mechanisms:

**`<include layout="@layout/foo" />`**: The included layout's views are
merged into the parent at runtime. Recursively read the included layout
file and collect its IDs as if they were in the parent. An `<include>`
may override the included root's `android:id` with its own.

**`<merge>`**: Has no ID itself. Its children are directly inlined into
the parent at inflation time. Treat its children as belonging to the
including parent.

**`<layout>` (Data Binding)**: Wraps the actual root view. Look inside
`<layout>` for the actual root view and its children. Ignore the `<data>`
section — it has no UI elements.

**`<ViewStub android:layout="@layout/foo" />`**: Lazily inflated. Its
content is NOT in the initial layout. `android:inflatedId` gives the ID
of the inflated root. Note these but understand they may not be visible
until explicitly inflated at runtime.

**Duplicate IDs across layout files**: The same `@+id/submit` can appear
in both `activity_main.xml` and `activity_search.xml`. This is normal and
NOT a conflict — each layout is independent, and only one is active at a
time. Do NOT try to deduplicate IDs across different layout files. At
runtime, TapHound's `observe` command dumps the live layout, so element
resolution always happens against the currently displayed screen.

## Step 3: Scan Build Files

Each module has either `build.gradle.kts` (Kotlin DSL) or `build.gradle`
(Groovy DSL), never both. Core already parsed these for `applicationId`,
`namespace`, and module discovery — you do NOT need to re-parse them for
identity. However, check for:

- `buildTypes` / `productFlavors` that might affect the package name
  (suffixes like `.debug`). Core uses the base `applicationId`; note if a
  flavor suffix is relevant to the test Goal.
- `proguard` / `proguardFiles` rules that might strip logcat tags. If
  Logcat calls are stripped in release builds, note this — it affects
  expectation feasibility.

## Step 4: Verify Completeness

Before filling in the `summary`, verify you have found ALL relevant files.
Incomplete coverage makes the Context useless for staleness detection and
leads to missing interaction policies.

### Activity completeness

Enumerate every `<activity>` declaration across ALL module manifests
(not just the `app` module):

```bash
find . -name "AndroidManifest.xml" -not -path "*/build/*"
find . -name "AndroidManifest.xml" -not -path "*/build/*" \
  -exec grep '<activity' {} + | sed 's/.*android:name="//' | sed 's/".*//'
```

For each Activity name found:
- If it starts with `.`, prepend the module's namespace to get the
  fully qualified class name.
- Find the corresponding source file (`.kt` or `.java`) on disk.
- If the source file cannot be found (generated class, third-party
  dependency), skip it but note it.

**You MUST include every Activity source file you find.** Missing
Activities means the Context cannot detect when those screens change,
and the AI agent will not know about their UI elements or Logcat tags.

### Layout completeness

For each Activity, identify its layout via `setContentView(R.layout.<name>)`
in the source. Then find the corresponding layout XML:

```bash
find . -path "*/res/layout/*.xml" -not -path "*/build/*"
```

Include each layout file directly referenced by an Activity you found.
Also include layouts referenced via `<include>` from those layouts
(resolve transitively). You may EXCLUDE:
- Layout files not referenced by any Activity (e.g., item layouts for
  RecyclerView adapters, preference layouts) unless they contain
  interactive elements the test Goal might touch.
- Debug-only or developer-tool layouts.

### Large project strategy

For projects with many modules (10+ Activities, 50+ layouts), use
systematic shell-based discovery rather than reading files one by one:

```bash
find . -name "AndroidManifest.xml" -not -path "*/build/*" \
  -exec grep -c '<activity' {} +
find . \( -name "*.kt" -o -name "*.java" \) -not -path "*/build/*" \
  -exec grep -l "extends.*Activity\|:.*Activity(" {} +
find . -path "*/res/layout/*.xml" -not -path "*/build/*" | wc -l
```

If the project has hundreds of Activities/layouts, keep each module as a
separate bounded analysis. Do not omit later modules and do not mark a
shard `complete` until its selected inventory categories were fully
enumerated.

## Step 5: Populate the `summary` Object

For each module shard, fill in the `summary` object with these fields
(all required by `schemas/project-context-module.json`):

- **`features`**: Domain terms this module contributes (e.g.,
  `"search"`, `"chat"`, `"camera"`).
- **`activities`**: Array of `{name, entryPoints, screens}`. `name` is
  the fully qualified Activity class. `entryPoints` lists launcher or
  deep-link entry Activities. `screens` lists user-visible screen names.
- **`elements`**: Array of `{screen, resourceId?, text?,
  contentDescription?, actions}`. At least one identity field is required.
  `actions` is the list of actions the element supports (`click`,
  `longClick`, `inputText`, `swipe`, `scrollTo`, `back`, `wait`).
- **`transitions`**: Array of `{fromActivity, toActivity, actionResourceId?
  | actionText?}` describing cross-Activity navigation.
- **`logcat`**: Array of `{tag, pattern, match}` where `match` is
  `"literal"` or `"regex"`. Derived from `Log.i`/`Log.d` calls in source.

Set the shard `status` to:
- `"complete"`: all inventory categories fully analyzed.
- `"partial"`: some categories analyzed, others skipped (note why).
- `"unsupported"`: module has no UI-relevant code (pure logic library).

Never leave a shard as `"notAnalyzed"` after this step.

## Step 6: Update the Root Index

Edit `.taphound/context/project-context.json`:

1. For each module entry in `modules[]`, copy `features`, `activities`,
   and `status` from the corresponding shard.

2. Update `interactionPolicy`:
   - **`allowedActions`**: List ONLY actions the UI actually supports,
     derived from source evidence. A Button supports `click`/`longClick`.
     An EditText supports `inputText`. A scrollable container (ScrollView,
     RecyclerView) supports `swipe`/`scrollTo`. System navigation supports
     `back`. Any screen supports `wait`. Do NOT list all actions blindly
     — if you found no `longClick` handlers in source, do not include
     `longClick`.
   - **`confirmationRequiredActions`**: WARNING — this is per-action-TYPE,
     not per-element. Listing `click` here means EVERY click in the entire
     app will require human TTY approval during generation. Only list an
     action here if ALL instances of that action in the app are potentially
     dangerous (e.g., an app where every click triggers a payment). In
     most apps, leave this EMPTY — the Core risk evaluator handles per-step
     risk assessment at runtime.
   - **`forbiddenActions`**: Actions that are dangerous by default
     (payment, account deletion, password changes, installing APKs,
     third-party app navigation). If none apply, leave empty.
   - No action may appear in both `allowedActions` and `forbiddenActions`.
   - Every action in `confirmationRequiredActions` must also be in
     `allowedActions`.

3. Do NOT modify `packageName`, `launchActivity`, `manifest.files`,
   `modules[].shardPath`, `modules[].sha256`, `modules[].moduleId`,
   `modules[].projectDir`, or `modules[].kind` — Core owns these.
   Do NOT add or remove module entries — Core discovered them.
   Do NOT modify any `sha256` or `semanticSha256` field — Core computed
   them. Run `context rehash` to recompute after your edits.

## Incremental Updates

When an existing Context is `stale`, Core's `context refresh` handles
hash maintenance. The agent only re-scans source when semantic analysis
is actually needed:

```bash
taphound context status --project <project> \
  --context .taphound/context/project-context.json --json
```

- `"valid"`: No action needed.
- `"stale"`: Run `context refresh --json`. It returns a `blocked` array;
  each block has a `code` and `resolution`:
  - `pruneDeleted` → `refresh --prune-deleted`
  - `acceptSourceChanges` → `refresh --accept-source-changes` (rehashes
    semantic edits). Re-analyze (Steps 1–5) only when the module summary
    is now wrong or new UI files were added.
  - `reanalyze` → Re-scan the affected module's source (Steps 1–5),
    update its `summary`, then `context rehash`.
- `"invalid"`: Run `context generate --force` and redo Steps 1–5.

The typical reconcile for routine edits + deletions:
```bash
taphound context refresh --project <project> \
  --context .taphound/context/project-context.json \
  --prune-deleted --accept-source-changes --json
```

`--module <id...>` narrows scope. `refresh` backfills `semanticSha256`,
rehashes formatting-only changes, and repairs drifted hashes. It never
removes a file for a non-deletion reason.

**Caveat**: `--accept-source-changes` does NOT re-analyze newly added
Activities or layouts into the module summary. If the Goal may reach a
new screen, re-scan that module's source (Steps 1–5) and update its
`summary`, then run `context rehash`.

### When to regenerate instead of refresh

Run `context generate --force` and redo full analysis (Steps 1–5) when:
- A new Gradle module was added or removed (check `settings.gradle`).
- The `packageName` or `launchActivity` changed.
- The Context is `"invalid"` (structural corruption).

## Rules

- The agent NEVER computes SHA-256 hashes manually. Core does all hashing
  via `context generate` and `context rehash`.
- The agent NEVER discovers modules manually. Core parses `settings.gradle`
  and falls back to filesystem scanning.
- The agent NEVER resolves `applicationId` or launch Activity manually.
  Core inspects build files and manifests.
- Paths in `manifest.files` are relative to the Android project root,
  use forward slashes, and must not start with `/` or contain `..`.
  Core already set these — do not modify them.
- For multi-module projects, include source analysis from all modules that
  contribute to the UI — not just the `app` module.
- **Completeness is mandatory**: enumerate ALL `<activity>` entries from
  ALL module manifests and include each Activity's source file analysis.
- For layouts using `<include>`, `<merge>`, or `<layout>`, resolve
  transitively to understand the full element set.
- `confirmationRequiredActions` is per-action-TYPE. Listing `click` makes
  EVERY click require human approval. Leave empty unless ALL instances of
  an action are dangerous.
- `allowedActions` must be derived from source evidence, not blanket
  inclusion. If no source evidence supports an action, do not list it.
- Do not include build artifacts, generated code, or non-UI files in your
  analysis — Core already excluded them from the evidence manifest.
