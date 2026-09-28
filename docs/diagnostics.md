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
  failure code, and run id;
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

## Reporting a problem

Attach the exported bundle to the issue together with what you expected and
what happened. The issue template asks for it.
