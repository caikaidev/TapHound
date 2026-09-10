# Local Target (real-app validation)

TapHound treats your *own* repository as a separate project from the device tool
chain. The `local` command group and the `--target` flags let you register an
unrelated Android repository (a "Local Target") and run `doctor`, `context`,
`verify`, `impact`, and `verify-changes` against it on demand, without copying
TapHound files into that repository or polluting its version control.

This is **dogfooding**: TapHound uses itself to validate a real app. Reports,
Journeys, and Context produced for a Local Target **are not publishable**
artifacts — they are working evidence for the developer loop.

## Naming

- A **target** is a named reference to an Android project on this machine
  (for example `my-app`). Its id is an identifier you choose (`local add`).
- The **targets home** is the base directory that holds the targets
  registration and each target's workspace. It is selected by the `--targets
  <path>` option, the `TAPHOUND_TARGETS_HOME` environment variable, or defaults
  to the CLI working directory (`cwd`).
- Constants like `benchmarks/targets.json`, `benchmarks/targets.local.json`,
  and `.taphound/local/<id>/` are all **relative to the targets home**, not to
  the target project. This is the base-dir semantics the whole feature follows.

## SCOPE (what is implemented vs deferred)

- **P0 (implemented):** registration, path resolution, Git identity, a local
  workspace per target, `doctor --target`, `context generate/status/validate
  --target`, `verify --target`, `verify-changes --target` (including an
  `impact --target`), and the local workspace footprint.
- **P1 (partial):** `verify-changes --target` with a dirty-worktree
  `--head WORKTREE`, project fingerprinting, Git metadata, and the coded exit
  codes. `generation --target` is **deferred**.
- **P2 (partial):** `local add/list/inspect/remove`. `local link` and a YAML
  config format are **deferred** (JSON was chosen to keep parsing
  zero-dependency and strict).

## Config files (JSON)

Target registration lives in **JSON**, not YAML. TapHound uses `z.strictObject`
schemas and parsing must stay zero-dependency, so JSON was chosen.

- `benchmarks/targets.json` — the **official, committed** registration file.
- `benchmarks/targets.local.json` — the **local overrides** file, git-ignored.
  A target id in the local file must also exist in the official file, and the
  local entry needs `"override": true` to take precedence.

A committed template with a `${TAPHOUND_WORK_APP}` placeholder is at
[`benchmarks/targets.example.json`](../benchmarks/targets.example.json). Copy
it to `benchmarks/targets.local.json` and fill in the placeholder, or register
the target with `local add` and let the CLI build the entry.

```json
{
  "version": 1,
  "targets": {
    "my-app": {
      "source": {
        "type": "local",
        "path": "${TAPHOUND_WORK_APP}"
      },
      "run": {
        "packageName": "com.example.myapp",
        "activity": ".MainActivity"
      },
      "git": {
        "enabled": true
      }
    }
  }
}
```

Each target entry is validated against the strict `TargetEntry` schema:

- `source.type` must be `"local"` and `source.path` is required.
- `run.packageName` is required and must be a qualified Java package;
  `run.activity` defaults to `.MainActivity`.
- `git.enabled` defaults to `true`.
- `override` defaults to `false` and is only meaningful in `targets.local.json`.
- `build`, `install`, `project`, `validation`, and `artifacts` are optional and
  unsupported in the current Local Target flow.

## Path resolution

`source.path` is resolved before use:

- `${VAR}` and `$VAR` are expanded from the environment. A missing or empty
  variable fails with **`LOCAL_TARGET_ENV_MISSING`**.
- `~` is expanded to the user's home directory.
- Relative paths are resolved against the **targets home**.
- The final path is realpath'd (symlinks are transparently resolved).

Example exposing a per-machine absolute path via an environment variable, so
the committed `targets.example.json` stays portable across machines:

```bash
# machine A: app lives at /home/alice/apps/example
export TAPHOUND_WORK_APP=/home/alice/apps/example

# machine B: app lives at /Users/bob/work/example
export TAPHOUND_WORK_APP=/Users/bob/work/example

node dist/cli/main.js doctor --target my-app --targets .
```

## Symlink example

The resolved path follows symlinks. A symlinked path such as
`~/src/apps/example-app -> /srv/repos/example-app` resolves to
`/srv/repos/example-app`. A broken symlink fails with
**`LOCAL_TARGET_SYMLINK_BROKEN`**; a path that is not a directory fails with
**`LOCAL_TARGET_NOT_DIRECTORY`**; a path that is not an Android/Gradle project
fails with **`LOCAL_TARGET_NOT_ANDROID_PROJECT`**.

```bash
$ ln -s /srv/repos/example-app ~/src/apps/example-app
$ node dist/cli/main.js local add my-app --path ~/src/apps/example-app --package com.example.myapp
Registered local target my-app at /srv/repos/example-app
```

## Workspace layout

Each target keeps its own workspace under the targets home
(`<base>/.taphound/local/<id>/`). Everything under it is git-ignored via a
generated `<base>/.taphound/.gitignore` that contains `local/`:

```text
<targets-home>/
  .taphound/
    .gitignore            # generated once with "local/"; never overwritten
    local/
      <id>/
        identity.json     # registered identity + project fingerprint + package
        context/          # Project Context generated for this target
        journeys/         # Journeys verified against this target
        runs/             # verify/verify-changes reports (screenshots, Logcat)
        generations/      # reserved (generation --target is deferred)
        cache/
```

The **target project repository never gains TapHound files.** All TapHound
artifacts live under the targets home, and the target repo's Git status stays
limited to the developer's own changes.

## CLI reference

### Register, list, inspect, remove

```bash
# Register. --package is required unless the id already has run.packageName stored.
node dist/cli/main.js local add my-app --path '/path/to/app' --package com.example.myapp --json

# List registered targets (JSON or human-readable).
node dist/cli/main.js local list --json

# Inspect one target (drive READY/MISSING, Git head/branch/dirty, context state, journey count).
node dist/cli/main.js local inspect my-app --json

# Remove a registration.
node dist/cli/main.js local remove my-app --json
```

Every `local` subcommand also accepts `--json` and `--targets <path>`. After
`npm run dev:setup` and `npm link`, replace `node dist/cli/main.js` with
`taphound`.

### `--target` on analysis commands

`--target <id>` selects a registered Local Target. Each also accepts
`--targets <path>` to choose the targets home (otherwise `TAPHOUND_TARGETS_HOME`
or `cwd`). Verify each is present with `node dist/cli/main.js <cmd> --help`:

- `doctor --target <id>`
- `context generate --target <id>` — roots Context in the target workspace
- `context status --target <id>` / `context validate --target <id>`
- `verify --target <id> --journey <name>`
- `verify-changes --target <id> --base <ref>` (and `impact --target <id>`)

## Verification against a Local Target

### `verify --target`

`verify --target <id> --journey <name>` replays the Journey named `<name>` from
the target's workspace (`<ws>/journeys/<name>.json`; a bare name, not a path).
The config is synthesized from the target's `run` block with the standard idle
policy (`hybrid`, `pollIntervalMs` 200, `stablePolls` 2, `timeoutMs` 5000).
Reports land under `<ws>/runs`. `--package` / `--activity` / `--reports` may
override the synthesized values. `--journey` must be a bare Journey name with
`--target`; passing a path fails.

```bash
node dist/cli/main.js verify --target my-app --journey search --json
```

### `verify-changes --target`

`verify-changes --target <id> --base <ref>` maps the Git change set
(`<base>..<head>`) onto the target's Context/Knowledge/Journeys and replays the
selected Journeys. With `--target`, the head defaults to
**`WORKTREE`**, so the changeset is the current uncommitted working tree
against `--base` (for example `origin/main`). This verifies the current
developer edits without requiring a commit.

```bash
node dist/cli/main.js verify-changes --target my-app --base origin/main --head WORKTREE --json
```

## Privacy rules

- The target project's sources are read-only. TapHound never writes into the
  target repository; generated Context, Journeys, reports, fingerprints, and
  Git metadata all live under the targets home.
- Paths stored in `identity.json` and the reports are the *resolved* absolute
  paths. If you commit a report you may expose a local absolute path or a
  private Git remote; Local Target evidence is intended for local working
  loops, not to be published.
- A Local Target workspace is git-ignored. Do not force-add it.

## Error codes

Target resolution and registration failures are mapped to coded exit codes
(exit code `2`) with actionable remediation:

| Code | Meaning | Remediation |
|---|---|---|
| `LOCAL_TARGET_NOT_FOUND` | The id is not registered | Register it: `taphound local add <id> --path <path> --package <name>` |
| `LOCAL_TARGET_ENV_MISSING` | A referenced environment variable is undefined | Export the variable or use an explicit path |
| `LOCAL_TARGET_PATH_INVALID` | The configured path cannot be resolved | Point at an existing directory |
| `LOCAL_TARGET_NOT_DIRECTORY` | The configured path is not a directory | Use a directory path, not a file |
| `LOCAL_TARGET_NOT_ANDROID_PROJECT` | No `settings.gradle(.kts)` / wrapper found | Point at an Android/Gradle project root |
| `LOCAL_TARGET_SYMLINK_BROKEN` | The path (or a symlink in it) does not resolve | Repair the symlink or fix the path |
| `LOCAL_TARGET_PROJECT_CHANGED` | The path now resolves to a different project than registered | Re-register, or point the path at the original repo |
| `TARGET_ID_CONFLICT` | The id conflicts (e.g. overriding without `override: true`) | Use a unique id or set `"override": true` in `targets.local.json` |
| `TARGET_CONFIG_INVALID` | The targets file or a target entry is invalid | Fix the JSON to match the strict target schema |
| `PACKAGE_IDENTITY_MISMATCH` | The detected package differs from the stored one | Pass `--package` matching the app, or realign the target |
| `GIT_ROOT_NOT_FOUND` | Git could not determine the target's repo root | Ensure the target project is a Git repository |
| `GIT_REF_INVALID` | A `--base` / `--head` Git ref is invalid | Use a valid ref (branch, tag, or `WORKTREE`) |

## Offline smoke (no device)

These need no device or network, and validate registration, workspace creation,
and Context generation end-to-end against the bundled demo project:

```bash
npm run build
node dist/cli/main.js local add demo --path examples/taphound-android-demo --package dev.taphound.demo --json
node dist/cli/main.js local list --json
node dist/cli/main.js local inspect demo --json
node dist/cli/main.js context generate --target demo --json
node dist/cli/main.js context status --target demo --json
```

Then clean up the smoke artifacts (they are git-ignored): remove
`benchmarks/targets.local.json` and the generated `<cwd>/.taphound/local/demo/`.
`verify` / `verify-changes` / `doctor` need an online device, so they are not
part of the offline smoke.