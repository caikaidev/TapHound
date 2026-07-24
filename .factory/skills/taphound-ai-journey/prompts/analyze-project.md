# Analyze Android Project for TapHound Context

You are generating a TapHound Project Context JSON file for an Android project.
Read the project source code and produce a Context that matches
`schemas/project-context.json`.

## What to Read

1. **`app/src/main/AndroidManifest.xml`** (or whichever manifest exists):
   - Extract the package name from the `<manifest>` `package` attribute or
     the `namespace` in `build.gradle`.
   - Identify the launch Activity: the `<activity>` with
     `android.intent.action.MAIN` and `android.intent.category.LAUNCHER`.
   - List all declared Activities.

2. **Kotlin/Java source files** under `app/src/main/java/`:
   - Find `setContentView(R.layout.*)` calls to map Activities to layouts.
   - Find `findViewById<Button>(R.id.*)`, `findViewById<EditText>(R.id.*)`,
     etc. to identify interactive UI elements and their `resourceId` values.
   - Find `setOnClickListener`, `setOnCheckedChangeListener`, etc. to
     determine which elements are actionable.
   - Find `Log.i(tag, message)`, `Log.d(tag, ...)`, etc. to identify logcat
     tags and patterns usable as expectations.
   - Find `startActivity(Intent(...))` to predict Activity transitions.

3. **Layout XML files** under `app/src/main/res/layout/`:
   - Extract `android:id="@+id/<name>"` — the `resourceId` for locators is
     the bare name (e.g., `open_search`, not `id/open_search`).
   - Extract `android:text` and `android:contentDescription` as fallback
     locator identity fields.
   - Note the widget type (Button, EditText, TextView, RecyclerView, etc.)
     to understand what actions each element supports.

4. **`build.gradle.kts` or `build.gradle`**:
   - Extract the application ID / namespace if the manifest doesn't have it.

## What to Produce

A JSON object with:

- `version`: `1`
- `packageName`: fully qualified package (e.g., `dev.taphound.demo`)
- `launchActivity`: fully qualified launch Activity (e.g.,
  `dev.taphound.demo.MainActivity`)
- `manifest.files`: list every source file you read that is relevant to the
  UI structure. For each, compute the SHA-256 using the shell command:
  ```bash
  node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('<relative-path>')).digest('hex'))"
  ```
  Set `confidence` to `"sourceConfirmed"` for files you directly read.
- `interactionPolicy`:
  - `allowedActions`: list actions the UI actually supports. A Button
    supports `click`/`longClick`. An EditText supports `inputText`. A
    scrollable container supports `swipe`/`scrollTo`. System navigation
    supports `back`. Any screen supports `wait`.
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

- Never guess a SHA-256 hash. Always compute it with the shell command above.
- Paths in `manifest.files` are relative to the project root, use forward
  slashes, and must not start with `/` or contain `..`.
- The `packageName` in the Context must exactly match the Android package.
- The `launchActivity` must exactly match the class in the manifest.
- Do not include files that are not relevant to UI structure (e.g., Gradle
  wrapper scripts, resource values, themes) unless they contain UI logic.
