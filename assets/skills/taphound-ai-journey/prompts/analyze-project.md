# Analyze Android Project for TapHound Context

You are generating or updating a TapHound Project Context Bundle v2 for an
Android project. Produce a compact root index matching
`schemas/project-context.json` and one shard per Gradle module matching
`schemas/project-context-module.json`.

The output directory is:

```text
.taphound/context/
├── project-context.json
└── modules/
    ├── app.json
    ├── feature-chat.json
    └── ...
```

Analyze modules one at a time as bounded tasks. A large project is not a
reason to omit modules. Every discovered module must appear in the root index
with status `complete`, `partial`, `unsupported`, or `notAnalyzed`.

There are two modes:
- **Full generation**: discover the complete module catalog, then generate
  each shard independently before writing the root index.
- **Incremental update**: regenerate only stale shards and update their
  hashes in the root index. If the Gradle module catalog changed, update the
  index and generate every new shard.

## Step 1: Discover Project Modules

Modern Android projects may have multiple modules. Activities, layouts, and
source files can live in any module, not just `app/`.

### 1a. Primary: `./gradlew projects`

Run the Gradle wrapper to get the authoritative module tree:

```bash
cd <project-root>
./gradlew projects --console=plain
```

This resolves the full project structure including `projectDir` overrides,
`includeBuild` composite builds, and nested subprojects. The output looks
like:

```
Root project 'taphound-demo'
+--- Project ':app'
+--- Project ':feature-search'
|    \--- Project ':feature-search:sub-widget'
\--- Project ':lib-ui'
```

For each `Project ':<path>'` line:
- The Gradle path (`:app`, `:feature-search`) identifies the module.
- The directory is derived from the path: replace `:` with `/`, drop the
  leading `/`. So `:feature-search` → `feature-search/`,
  `:feature-search:sub-widget` → `feature-search/sub-widget/`.
- If the project uses `projectDir` overrides, the Gradle path may not
  match the directory. In that case, check `settings.gradle(.kts)` for the
  explicit `project(...).projectDir` mapping (see 1b).

> **Note**: `./gradlew projects` runs a configuration phase which can be
> slow on first run (downloading dependencies). Subsequent runs are fast
> due to Gradle daemon caching. If the wrapper is not executable
> (`./gradlew: Permission denied`), run `chmod +x gradlew` first. On
> Windows, use `gradlew.bat projects`.

### 1b. Fallback: parse `settings.gradle(.kts)`

If `./gradlew projects` is unavailable (no wrapper, no JDK, or timeout),
parse `settings.gradle` or `settings.gradle.kts` at the project root:

1. Extract all module names from `include` statements:
   ```
   include ':app', ':feature-search', ':lib-ui'
   ```
2. For each included module, check for `projectDir` overrides:
   ```
   project(':feature-search').projectDir = file('features/search')
   ```
   If overridden, use the specified directory. Otherwise, derive the
   directory from the path (drop `:`, replace remaining `:` with `/`).
3. **Watch for custom functions**: Some projects use helper functions
   like `includeModule()` that dynamically include modules. If you see
   function calls in `settings.gradle` that are not standard Gradle,
   you MUST use the filesystem fallback below — parsing `include`
   statements alone will miss modules.
4. **Filesystem fallback** (use when `settings.gradle` has custom
   functions or `./gradlew projects` is unavailable):
   ```bash
   find . -name "build.gradle" -o -name "build.gradle.kts" \
     | grep -v '/build/' | sort
   ```
   Each result is a module directory. This catches all modules
   regardless of how they are included in `settings.gradle`.
5. If no `settings.gradle` exists, treat the project as single-module
   with the root directory as the only module.

### 1c. Identify the app module

The app module (the one that produces the APK) is the one with
`applicationId` or `applicationIdSuffix` in its `build.gradle(.kts)`, or
a `<application>` tag in its `AndroidManifest.xml`. Library modules have
`com.android.library` plugin instead of `com.android.application`.

## Step 2: Determine packageName

Modern Android projects (AGP 7.0+) no longer set the `package` attribute
in `AndroidManifest.xml`. Determine the package name in this priority
order:

1. **`applicationId` in the app module's build file**:
   Check both `build.gradle.kts` (Kotlin DSL) and `build.gradle` (Groovy
   DSL). One of them will exist; projects do not use both in the same
   module.

   Kotlin DSL (`build.gradle.kts`) — uses `=`:
   ```kotlin
   android {
       defaultConfig {
           applicationId = "dev.taphound.demo"
       }
   }
   ```

   Groovy DSL (`build.gradle`) — no `=`:
   ```groovy
   android {
       defaultConfig {
           applicationId "dev.taphound.demo"
       }
   }
   ```

   This is the authoritative package name. Use this if present.

2. **`package` attribute in `AndroidManifest.xml`** (legacy):
   ```xml
   <manifest xmlns:android="..."
       package="dev.taphound.demo">
   ```
   Use this only if `applicationId` is not set in either build file.

3. **`namespace` in the build file** (fallback):
   Same dual-syntax as above — Kotlin DSL uses `=`, Groovy does not.

   Kotlin DSL:
   ```kotlin
   android {
       namespace = "dev.taphound.demo"
   }
   ```

   Groovy DSL:
   ```groovy
   android {
       namespace "dev.taphound.demo"
   }
   ```

   `namespace` is used for R class generation and is NOT the same as
   `applicationId` (they can differ, especially with build flavors or
   suffixes). Use `namespace` only when neither `applicationId` nor
   `package` is available.

> **Important**: If the project uses build flavors with different
> `applicationId` suffixes (e.g., `.debug`, `.staging`), use the base
> `applicationId` without the suffix. TapHound verifies against the
> installed package at runtime.

### 2a. Dynamic applicationId resolution

Some projects do not set `applicationId` to a string literal. Instead,
they reference a Gradle ext property or a function call:

```groovy
// app/build.gradle
applicationId gradle.ext.buildApplicationId
```

When you encounter a non-literal `applicationId`, trace the resolution
chain to find the actual string value:

1. Search for the variable definition in `gradle.properties`:
   ```bash
   grep -rn "buildApplicationId" gradle.properties
   # Example: buildApplicationId=com.sample.tchat
   ```
2. If not in `gradle.properties`, search all `.gradle` files under
   `gradle/` for the assignment:
   ```bash
   grep -rn "buildApplicationId" gradle/ --include="*.gradle"
   ```
3. If the variable is set via a function call (e.g.,
   `gradle.ext.buildApplicationId = getApplicationId()`), find the
   function definition and trace its return value.
4. **Include ALL files in the resolution chain** in `manifest.files`:
   - `gradle.properties` (if it defines the value)
   - Any `.gradle` file that contains the variable assignment or function
     definition (e.g., `gradle/prebuild.gradle`)
   - `app/build.gradle` (where `applicationId` is referenced)

   These files are part of the package name provenance and must be
   tracked for staleness detection.

## Step 3: Identify Launch Activity

1. Read the **app module's** `src/main/AndroidManifest.xml`.
2. Find the `<activity>` that contains an `<intent-filter>` with both:
   - `<action android:name="android.intent.action.MAIN" />`
   - `<category android:name="android.intent.category.LAUNCHER" />`
3. The `android:name` attribute gives the Activity class. If it starts
   with `.` (e.g., `.MainActivity`), prepend the package name to get the
   fully qualified class (e.g., `dev.taphound.demo.MainActivity`).

> **Multi-module note**: Library modules may declare their own Activities
> in their own manifests. These get merged into the final manifest at
> build time. The launch Activity is almost always in the `app` module's
> manifest. If not found there, check merged manifest output in
> `app/build/intermediates/merged_manifests/` (do not hash build
> artifacts — only use them for discovery).

## Step 4: Scan Each Module Independently

For each module discovered in Step 1, complete Steps 4–6 and write that
module's shard before moving to the next module. Scan `src/main/` (and
variant source sets when applicable):

### 4a. Kotlin/Java source (`src/main/java/` or `src/main/kotlin/`)

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

### 4b. Layout XML (`src/main/res/layout/`)

Extract UI element information from layout files:

- Extract `android:id="@+id/<name>"` — the `resourceId` for locators is
  the bare name (e.g., `open_search`, not `id/open_search`).
- Extract `android:text` and `android:contentDescription` as fallback
  locator identity fields.
- Note the widget type (Button, EditText, TextView, RecyclerView,
  ScrollView, etc.) to understand what actions each element supports.

#### Handling Complex Layout Structures

Real Android layouts use several composition mechanisms. Handle each:

**`<include layout="@layout/foo" />`**:
- The included layout's views are merged into the parent at runtime.
- Recursively read the included layout file and collect its IDs as if
  they were in the parent.
- An `<include>` may override the included root's `android:id` with its
  own `android:id` attribute — note both the include ID and the included
  layout's child IDs.

**`<merge>`**:
- `<merge>` has no ID itself. Its children are directly inlined into the
  parent at inflation time.
- When you encounter `<merge>` as the root of an included layout, treat
  its children as belonging to the including parent.

**`<layout>` (Data Binding)**:
- The `<layout>` tag wraps the actual root view. It may also contain
  `<data>` elements (variable definitions).
- Look inside `<layout>` for the actual root view and its children.
  Ignore the `<data>` section — it has no UI elements.

**`<ViewStub android:layout="@layout/foo" />`**:
- A `ViewStub` is lazily inflated. Its content is NOT in the initial
  layout. The `android:inflatedId` attribute gives the ID of the
  inflated root, and `android:layout` points to the layout resource.
- Note these elements but understand they may not be visible until
  explicitly inflated at runtime.

**Duplicate IDs across layout files**:
- The same `@+id/submit` can appear in both `activity_main.xml` and
  `activity_search.xml`. This is normal and NOT a conflict — each
  layout is independent, and only one is active at a time.
- Do NOT try to deduplicate IDs across different layout files.
- At runtime, TapHound's `observe` command dumps the live layout, so
  element resolution always happens against the currently displayed
  screen, not against static XML.
- What matters for the Context is understanding which IDs exist and
  what actions they support, so you can set `interactionPolicy`
  correctly and so the step-generation prompt can make informed
  decisions.

### 4c. Build files (Kotlin DSL or Groovy DSL)

Each module has either `build.gradle.kts` (Kotlin DSL) or `build.gradle`
(Groovy DSL), never both. Check which file exists before reading.

- Read the app module's build file for `applicationId` (Step 2) and
  `namespace`. The syntax differs:
  - Kotlin DSL: `applicationId = "..."`, `namespace = "..."`
  - Groovy DSL: `applicationId "..."`, `namespace "..."`
- Check for `buildTypes` / `productFlavors` that might affect the
  package name (suffixes like `.debug`). In Kotlin DSL these use `=`,
  in Groovy they do not.
- Read `settings.gradle.kts` or `settings.gradle` (whichever exists) for
  module includes if using the fallback method in Step 1.
- Note any `proguard` / `proguardFiles` rules that might strip logcat
  tags (if Logcat calls are stripped in release builds, note this — it
  affects expectation feasibility).

## Step 5: Verify Completeness

Before generating the Context JSON, verify that you have found ALL
relevant files. Incomplete coverage makes the Context useless for
staleness detection and leads to missing interaction policies.

### 5a. Activity completeness

Enumerate every `<activity>` declaration across ALL module manifests
(not just the `app` module). Use shell commands to ensure nothing is
missed:

```bash
# Find all manifest files (excluding build artifacts)
find . -name "AndroidManifest.xml" -not -path "*/build/*"

# Extract all activity names from all manifests
find . -name "AndroidManifest.xml" -not -path "*/build/*" \
  -exec grep '<activity' {} + | sed 's/.*android:name="//' | sed 's/".*//'
```

For each Activity name found:
- If it starts with `.`, prepend the module's namespace to get the
  fully qualified class name.
- Find the corresponding source file (`.kt` or `.java`) on disk.
- If the source file cannot be found (e.g., generated class, or class
  from a third-party dependency), skip it but note it.

**You MUST include every Activity source file you find.** Missing
Activities means the Context cannot detect when those screens change,
and the AI agent will not know about their UI elements or Logcat tags.

### 5b. Layout completeness

For each Activity you found, identify its layout via
`setContentView(R.layout.<name>)` in the source. Then find the
corresponding layout XML:

```bash
# Find all layout XML files across all modules (excluding build artifacts)
find . -path "*/res/layout/*.xml" -not -path "*/build/*"
```

Include each layout file that is directly referenced by an Activity
you found. Also include layouts referenced via `<include>` from those
layouts (resolve transitively).

You may EXCLUDE:
- Layout files not referenced by any Activity (e.g., item layouts for
  RecyclerView adapters, preference layouts) unless they contain
  interactive elements the test Goal might touch.
- Debug-only or developer-tool layouts.

### 5c. Large project strategy

For projects with many modules (10+ Activities, 50+ layouts), use
systematic shell-based discovery rather than reading files one by one:

```bash
# Count activities per module
find . -name "AndroidManifest.xml" -not -path "*/build/*" \
  -exec grep -c '<activity' {} +

# Count source files with Activity classes
find . \( -name "*.kt" -o -name "*.java" \) -not -path "*/build/*" \
  -exec grep -l "extends.*Activity\|:.*Activity(" {} +

# Count layout files
find . -path "*/res/layout/*.xml" -not -path "*/build/*" | wc -l
```

If the project has hundreds of Activities/layouts, keep each module as a
separate bounded analysis. If one Gradle module alone is too large, split its
analysis into internal parts, then merge the results into the module shard.
Do not omit later modules and do not mark a shard `complete` until its selected
inventory categories were fully enumerated.

## Step 6: Compute Evidence and Inventory Hashes

For every file you include in the Context manifest, compute its SHA-256
using this shell command (NEVER guess a hash):

```bash
node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<relative-path>')).digest('hex'))"
```

Also compute `semanticSha256` for each evidence file. It is a conservative
SHA-256 over the file after removing comments and formatting whitespace while
preserving string contents and all other tokens. TapHound uses this value to
ignore formatting-only edits but still reject semantic source changes. If the
file cannot be token-normalized safely, omit `semanticSha256`; the legacy
full-file hash behavior remains strict for that file.

The path must be relative to the Android project root (not the TapHound
repo root), use forward slashes, and must not start with `/` or contain
`..`.

For every module shard, enumerate all paths in its selected inventory
categories:

- `manifests`: `AndroidManifest.xml`
- `sources`: `.kt` and `.java`
- `layouts`: `res/layout*/*.xml`
- `navigation`: `res/navigation*/*.xml`

Exclude `.git`, `.gradle`, `.idea`, `.taphound`, and every `build` directory.
Sort project-relative paths lexicographically, join them with a single `\n`
and no trailing newline, then SHA-256 that exact UTF-8 string into
`inventory.pathSetSha256`. This detects files added or removed later.

## Step 7: Generate Module Shards and Root Index

For every module, first produce a module shard with:

- `version: 2`
- exact Gradle `moduleId` and project-relative `projectDir`
- explicit completeness `status`
- inventory categories and path-set hash
- source evidence manifest
- semantic `summary` containing feature terms, Activities, screens,
  actionable elements, cross-Activity transitions, and source-confirmed
  Logcat candidates

Write the shard, then compute the SHA-256 of the complete shard file bytes.

Finally produce the root index with:

- `version`: `2`
- `packageName`: the `applicationId` from the app module's build file
  (`build.gradle.kts` or `build.gradle`, per Step 2), or `package` from
  manifest as fallback.
- `launchActivity`: fully qualified launch Activity class, per Step 3.
- `manifest.files`: project-level identity and module-catalog evidence such
  as settings files, app build files, and dynamic applicationId resolution
  files. Module UI evidence belongs in shards.
- `modules`: every discovered module with routing features, Activity names,
  dependency IDs, shard path, shard file hash, kind, and explicit status.
  - Do NOT include build artifacts (`build/` directory), generated files,
    Gradle wrapper scripts, resource values (strings.xml, colors.xml),
    or themes unless they contain UI logic.
  - Set `confidence` to `"sourceConfirmed"` for files you directly read.
- `interactionPolicy`:
  - `allowedActions`: list ONLY actions the UI actually supports, derived
    from source evidence. A Button supports `click`/`longClick`. An
    EditText supports `inputText`. A scrollable container (ScrollView,
    RecyclerView) supports `swipe`/`scrollTo`. System navigation supports
    `back`. Any screen supports `wait`. Do NOT list all actions blindly
    — if you found no `longClick` handlers in source, do not include
    `longClick`.
  - `confirmationRequiredActions`: **WARNING — this is per-action-TYPE,
    not per-element.** Listing `click` here means EVERY click in the
    entire app will require human TTY approval during generation, making
    the process extremely tedious. Only list an action here if ALL
    instances of that action in the app are potentially dangerous (e.g.,
    an app where every click triggers a payment). In most apps, leave
    this EMPTY — the Core risk evaluator handles per-step risk
    assessment at runtime and will flag dangerous actions automatically.
  - `forbiddenActions`: actions that are dangerous by default (payment,
    account deletion, password changes, installing APKs, third-party app
    navigation). If none apply, leave empty.
  - No action may appear in both `allowedActions` and `forbiddenActions`.
  - Every action in `confirmationRequiredActions` must also be in
    `allowedActions`.

## Rules

- Never guess a SHA-256 hash. Always compute it with the shell command.
- Paths in `manifest.files` are relative to the Android project root,
  use forward slashes, and must not start with `/` or contain `..`.
- The `packageName` in the Context must exactly match the Android
  `applicationId` (or legacy `package` attribute). For dynamic
  `applicationId` references, trace the full resolution chain and include
  all files in that chain.
- The `launchActivity` must exactly match the class in the manifest.
- For multi-module projects, include files from all modules that
  contribute to the UI — not just the `app` module. Use `./gradlew
  projects` or the filesystem fallback to discover ALL modules.
- **Completeness is mandatory**: enumerate ALL `<activity>` entries from
  ALL module manifests and include each Activity's source file. Missing
  Activities means the Context cannot detect source changes and the AI
  agent will not know about those screens.
- For layouts using `<include>`, `<merge>`, or `<layout>`, resolve
  transitively to understand the full element set, but only hash the
  actual XML files you read.
- Do not include build artifacts, generated code, or non-UI files in
  `manifest.files`.
- `confirmationRequiredActions` is per-action-TYPE. Listing `click`
  makes EVERY click require human approval. Leave empty unless ALL
  instances of that action are dangerous.
- `allowedActions` must be derived from source evidence, not blanket
  inclusion. If no source evidence supports an action, do not list it.

## Incremental Update Mode

When an existing Context is `stale`, use the reported shard or evidence
failure to perform a targeted module update instead of full regeneration.

### Procedure

1. **Identify changed files**: Compare current file hashes with the
   Context's `manifest.files` entries. The `context status` command
   reports which files are stale.

2. **Re-hash changed files**: Recompute SHA-256 for each stale file:
   ```bash
   node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<relative-path>')).digest('hex'))"
   ```

3. **Re-analyze changed Activity source files**: For each stale `.kt` or
   `.java` file, re-read it and check for:
   - New `Log.i(tag, ...)` / `Log.d(tag, ...)` calls (new expect
     candidates)
   - New `setOnClickListener` / `setOnCheckedChangeListener` (new
     actionable elements)
   - New `startActivity(Intent(...))` (new navigation targets)
   - Removed elements (locators/expectations that no longer apply)
   Update `interactionPolicy.allowedActions` if new action types appeared.

4. **Re-analyze changed layout XML files**: For each stale layout, re-read
   it and check for:
   - New `android:id="@+id/<name>"` elements (new locator candidates)
   - Removed elements
   - Changed `android:text` or `android:contentDescription`
   - New `<include>` / `<merge>` / `<ViewStub>` references
   Resolve any new `<include>` references transitively.

5. **Update the module shard**: Replace stale hashes, inventory, and semantic
   summaries. Write it, recompute the shard file hash, and update that hash in
   the root index. Update the global interaction policy only when needed.

6. **Validate**:
   ```bash
   taphound context validate \
     --project <project> \
     --context .taphound/context/project-context.json \
     --json
   ```

### When NOT to use incremental update

Update the root index and affected shards if:
- Module inventory changed because a source, Activity, layout, manifest, or
  navigation file was added or removed.
- A new module was added (check `settings.gradle` or run `./gradlew projects`).
- The `packageName` or `launchActivity` changed.

Do not regenerate unrelated complete shards.
