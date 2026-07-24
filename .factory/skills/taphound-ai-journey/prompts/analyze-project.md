# Analyze Android Project for TapHound Context

You are generating a TapHound Project Context JSON file for an Android project.
Read the project source code and produce a Context that matches
`schemas/project-context.json`.

## Step 1: Discover Project Modules

Modern Android projects may have multiple modules. Activities, layouts, and
source files can live in any module, not just `app/`.

1. Read `settings.gradle` or `settings.gradle.kts` at the project root.
2. Extract all module names from `include` statements:
   ```
   include ':app'
   include ':feature-search'
   include ':lib-ui'
   ```
3. For each included module, note its directory path. By convention the
   path is `<name>` (drop the leading `:`), but `project` directives may
   override it:
   ```
   include ':feature-search'
   project(':feature-search').projectDir = file('features/search')
   ```
4. If no `settings.gradle` exists, treat the project as single-module
   with the root directory as the only module.

## Step 2: Determine packageName

Modern Android projects (AGP 7.0+) no longer set the `package` attribute
in `AndroidManifest.xml`. Determine the package name in this priority
order:

1. **`applicationId` in the app module's `build.gradle(.kts)`**:
   ```kotlin
   android {
       defaultConfig {
           applicationId = "dev.taphound.demo"
       }
   }
   ```
   This is the authoritative package name. Use this if present.

2. **`package` attribute in `AndroidManifest.xml`** (legacy):
   ```xml
   <manifest xmlns:android="..."
       package="dev.taphound.demo">
   ```
   Use this only if `applicationId` is not set in build.gradle.

3. **`namespace` in `build.gradle(.kts)`** (fallback):
   ```kotlin
   android {
       namespace = "dev.taphound.demo"
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

## Step 4: Scan Source Files Across All Modules

For each module discovered in Step 1, scan `src/main/` (and
`src/<flavor>/main/` if flavors exist):

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

### 4c. Build files (`build.gradle` or `build.gradle.kts`)

- Read the app module's build file for `applicationId` (Step 2) and
  `namespace`.
- Check for `buildTypes` / `productFlavors` that might affect the
  package name (suffixes like `.debug`).
- Note any `proguard` rules that might strip logcat tags (if Logcat
  calls are stripped in release builds, note this — it affects
  expectation feasibility).

## Step 5: Compute SHA-256 Hashes

For every file you include in the Context manifest, compute its SHA-256
using this shell command (NEVER guess a hash):

```bash
node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<relative-path>')).digest('hex'))"
```

The path must be relative to the Android project root (not the TapHound
repo root), use forward slashes, and must not start with `/` or contain
`..`.

## Step 6: Generate the Context JSON

Produce a JSON object with:

- `version`: `1`
- `packageName`: the `applicationId` from build.gradle (or `package` from
  manifest as fallback), per Step 2.
- `launchActivity`: fully qualified launch Activity class, per Step 3.
- `manifest.files`: list every source file you read that is relevant to
  the UI structure. Include:
  - All `AndroidManifest.xml` files (from app and library modules).
  - All Kotlin/Java source files that define Activities, handle UI
    interactions, or emit logcat tags used for expectations.
  - All layout XML files that are referenced by Activities (directly via
    `setContentView` or transitively via `<include>`).
  - The app module's `build.gradle(.kts)` (for `applicationId`).
  - `settings.gradle(.kts)` if multi-module.
  - Do NOT include build artifacts (`build/` directory), generated files,
    Gradle wrapper scripts, resource values (strings.xml, colors.xml),
    or themes unless they contain UI logic.
  - Set `confidence` to `"sourceConfirmed"` for files you directly read.
- `interactionPolicy`:
  - `allowedActions`: list actions the UI actually supports across all
    screens. A Button supports `click`/`longClick`. An EditText supports
    `inputText`. A scrollable container (ScrollView, RecyclerView)
    supports `swipe`/`scrollTo`. System navigation supports `back`. Any
    screen supports `wait`.
  - `confirmationRequiredActions`: actions that modify server-side or
    irreversible state (submit, send, delete, logout). If you cannot
    determine this from source alone, leave empty.
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
  `applicationId` (or legacy `package` attribute).
- The `launchActivity` must exactly match the class in the manifest.
- For multi-module projects, include files from all modules that
  contribute to the UI — not just the `app` module.
- For layouts using `<include>`, `<merge>`, or `<layout>`, resolve
  transitively to understand the full element set, but only hash the
  actual XML files you read.
- Do not include build artifacts, generated code, or non-UI files in
  `manifest.files`.
