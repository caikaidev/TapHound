# Diagnostics and Feedback

TapHound keeps a small local journal of what each command did and how long
the UI backend took, so a problem report can carry evidence instead of only a
description. Nothing leaves the machine unless the user sends the exported
file themselves. TapHound never uploads anything.

## What is recorded

Every CLI invocation appends one JSON line to
`.taphound/build/log/events.jsonl` (Git-ignored). The line holds:

- the command path (`verify`, `generation step`) and the names of the flags
  the user passed, never their values;
- duration, exit code, and, for `--json` commands, the output `status`,
  failure code (Replay and Generation codes), and run id;
- per UI backend: capture count, total and maximum latency, a latency
  histogram (`<250`, `<500`, `<1000`, `<2000`, `<5000`, `≥5000` ms), failures
  by kind (`timeout`, `cancelled`, `http4xx`, `http5xx`, `error`), and Appium
  session recoveries;
- TapHound, Node.js, OS platform, and CPU architecture versions.

The journal is appended only where a command already created the ignored
build layout (`.taphound/build/` and `.taphound/.gitignore`), so read-only
commands such as `observe` never create project files. It is capped at 1 MB
with one rotated predecessor (`events.1.jsonl`). Writing it never changes a
command's output or exit code. Disable it with `TAPHOUND_DIAGNOSTICS=off`.

## Exporting a bundle

```bash
taphound diagnose export --project /path/to/android-project
```

The command writes
`.taphound/build/diagnostics/taphound-diagnostics-<timestamp>.json` (or
`--out <path>`) from the most recent journal events (`--events`, default 50)
and summaries of the Replay reports they reference (`--runs`, default 10). It
fails with `CONFIG_INVALID` outside a TapHound project. `--json` prints
`{status, exitCode, path, events, runs}`.

The bundle is built from an allowlist and validated against a strict schema
(`src/domain/diagnostics.ts`), so a field that is not declared cannot appear:

| Kept | Transformed | Dropped |
|---|---|---|
| command outcomes, durations, UI backend latency and failures | Activity, Journey, device role, and run id names become `activity#1`, `journey#1`, `device#1`, `run#1` | project paths, package name, device serials |
| idle, UI, and runtime config values | locator values become a 16-hex HMAC-SHA256 digest keyed by a local salt, plus the names of the fields used | locator values, messages, and all free text |
| per step: action, status, failure code, duration, idle polls and sampling time, cache hits, Logcat drop counts | | screenshots, UI hierarchies, Logcat text, Project Context, Journey bodies |
| UI backend id and version, `node`/`adb`/`android` versions | | other tool names and versions |

The salt lives in `.taphound/build/log/salt` and never leaves the host, so a
digest cannot be reversed by guessing common strings, while the same locator
keeps the same digest across runs. Review the file before sharing it.

## Packing generation evidence

`diagnose export` deliberately drops layouts, step evidence, and free text.
Timing and screen-state problems (slow idle waits, a post-action snapshot that
shows a loading screen, a locator that misses) need that evidence, so
TapHound ships a standalone packer that keeps it and redacts identifiers
instead. It needs only Node.js and `tar`:

```bash
cd /path/to/android-project
node "$(npm root -g)/taphound/scripts/feedback-pack.mjs" --run <runId>
```

(From a TapHound checkout, run `node scripts/feedback-pack.mjs --project
/path/to/android-project`.) It collects every JSON file under
`.taphound/build/generations/` (including unfinished `.<id>.work` bundles:
`state.json`, `meta.json`, per-step `proposal.json`/`result.json` with
`timing`, every `snapshot.json`, `verification/report.json`) plus the
`runs/<runId>/report.json` of each `--run`. `--generation <id>` narrows it.
Screenshots, Logcat text, and other non-JSON files are never copied.

Identifiers become stable pseudonyms so files still cross-reference: the
package becomes `com.example.app`, app classes and Activities
`com.example.app.Activity<N>`, resource ids `com.example.app:id/r<N>` (or
`r<N>` for bare names), UI text, window titles, and Logcat tags/patterns
`T<N>`, device serials `device-<N>`, and the project path `<project>`.
Platform names (`android.*`, `androidx.*`, `com.android.*`) and all timing,
bounds, and status fields are kept. UI text is replaced only in text fields,
so a label that reads `passed` never rewrites a `status`. Diagnostic
sentences (`message`, `reason`, ...) get the same substitutions, except UI
text shorter than three characters.

The archive and a `<archive>.mapping.json` land in
`.taphound/build/diagnostics/` (or `--out`). The mapping translates
pseudonyms back; keep it local and never attach it. Unpack the archive and
search it for names specific to your product before sharing.

## Reporting a problem

Attach the exported bundle to the issue together with what you expected and
what happened. The issue template asks for it.
