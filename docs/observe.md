# TapHound observe

`taphound observe` captures a point-in-time device snapshot for the configured
package without creating or advancing a generation session. It is the
inspection primitive used during Journey authoring, Brief `needs-observation`
edge verification, and ad-hoc device debugging.

## Synopsis

```bash
taphound observe --project <path> [--config <path>] [--device <serial>] \
  [--logcat-lines <N>] [--json]
```

- `--project <path>`: Android project root containing `.taphound/`. Defaults
  to the CLI working directory.
- `--config <path>`: TapHound config path relative to `--project`. Defaults to
  `.taphound/config.json`.
- `--device <serial>`: Select an online Android device. Required when more
  than one device is online; auto-selected when exactly one is online.
- `--logcat-lines <N>`: Dump the last `N` logcat lines into `report.logcat`.
  Omit to skip logcat capture.
- `--json`: Emit a single machine-readable JSON value to stdout. Progress and
  diagnostics go to stderr. The JSON `exitCode` matches the process exit code.

## Preflight and Exit Codes

`taphound observe` runs the same `doctor` preflight as `record` and `verify`:
it validates the config, checks that ADB, Android CLI, and an online device
are available, and selects a device. A config validation failure exits with
code `2` (`CONFIG_INVALID`). A doctor failure exits with code `3`
(`ENVIRONMENT_MISSING_TOOL` or the specific failing check). Provider
availability failures use `UI_BACKEND_UNAVAILABLE`/exit `3`; capture or source
validation failures use `UI_SNAPSHOT_FAILED` or `UI_SNAPSHOT_INVALID`/exit `1`.
An internal error during observation exits with code `4` (`INTERNAL_ERROR`). A successful
observation exits with code `0`.

## Output Schema

With `--json`, the command emits exactly one JSON value to stdout:

```json
{
  "status": "observed",
  "exitCode": 0,
  "report": {
    "deviceSerial": "emulator-5554",
    "packageName": "com.example.app",
    "activity": "com.example.app.SearchActivity",
    "foreground": {
      "packageName": "com.example.app",
      "activity": "com.example.app.SearchActivity"
    },
    "uiBackend": {
      "id": "system-uiautomator",
      "adapterVersion": "system-uiautomator-v1",
      "engineVersion": "android-api-36",
      "configSha256": "<sha256>"
    },
    "uiCaptureDurationMs": 42,
    "uiCache": {
      "hits": 0,
      "misses": 1,
      "stale": 0,
      "relearns": 0,
      "capturesSaved": 0,
      "validationDurationMs": 0
    },
    "layout": [
      {
        "id": "search_input_node",
        "resourceId": "search_input",
        "enabled": true,
        "bounds": { "left": 0, "top": 100, "right": 200, "bottom": 200 },
        "children": []
      }
    ],
    "logcat": [
      "I/SearchViewModel( 1234): submitted query=hello world"
    ]
  }
}
```

`uiCache` is optional diagnostics for the current command only. It does not
make a snapshot authoritative and is omitted when `ui.cacheEnabled=false`.

`report` conforms to the `ObserveReport` schema:

- `deviceSerial`: the device TapHound observed.
- `packageName`: the configured target package (from `config.run.packageName`).
- `activity`: the target package's current Activity. Omitted when the foreground
  package differs from the configured target package; the `foreground` entry
  then carries the actual foreground component.
- `foreground`: the actual foreground component at capture time, regardless of
  whether it is the target package. `foreground.packageName` may differ from
  `packageName` when the device is mid-transition or on a system surface.
- `uiBackend`: the fixed provider descriptor selected when the command opens
  its device-bound UI session.
- `uiCaptureDurationMs`: duration of the reported UI capture, in milliseconds.
- `layout`: the parsed Layout tree for the target package, in the same
  `LayoutElement` shape used by `record`, `verify`, and `generation`.
- `logcat`: present only when `--logcat-lines` is supplied and greater than
  zero. Each entry is one raw logcat line, with the trailing newline stripped.

Without `--json`, the command writes a short human-readable summary to stdout
(device, package, activity, foreground, layout element count, logcat line
count) and exits `0`.

## Comparison with `generation observe`

`generation observe` is a subcommand of `taphound generation` that captures an
authoritative runtime snapshot bound to an active generation session.
`taphound observe` is a standalone inspection primitive. The two commands
share the same Layout and foreground primitives but differ in scope,
persistence, and binding semantics:

| Aspect | `taphound observe` | `generation observe` |
|---|---|---|
| Session | none required | requires `--session <id>` |
| Evidence persistence | writes nothing; stdout is the only artifact | writes `screen.png` and `snapshot.json` into the authoritative generation bundle under `.taphound/build/generations/<id>/` |
| Binding | returns no binding | returns `generationId`, `baseRevision`, `snapshotHash`, and a `snapshotRef` that subsequent proposals must bind to |
| Revision advance | no | advances the session revision atomically via the session store |
| State checks | runs `doctor` (config + env + device) | asserts the session is `active`, idle (`inFlight === null`), and has no pending risk confirmation |
| Foreground tolerance | explicitly tolerates non-target foreground; `activity` is omitted when the foreground package differs from the configured target package | collects the foreground component as-is into the snapshot and stamps `expectedPackageName` from the session target for snapshot traceability |
| Output shape | `{ status, exitCode, report: ObserveReport }` | `{ status, exitCode, ...binding, snapshotRef, snapshot? }` |
| Authoritative use | Brief `needs-observation` edge verification and ad-hoc inspection | authoring generation proposals that must bind to a session revision |

Because `taphound observe` writes no evidence and advances no revision, it is
safe to run repeatedly without disturbing an in-flight generation session,
and it can inspect device state that `generation observe` would refuse to bind
(for example a foreground that is not the target package, or a state that has
not yet satisfied the session's idle policy).

## Use in Brief `needs-observation` Edges

A TapHound Journey Brief may mark a State Transition Map edge as
`needs-observation`, signalling that the Brief's Activity and locator claims
for that edge must be verified against a live Runtime Snapshot before they may
inform a proposed generation step. `taphound observe` is the lightweight
inspection command for that verification:

```bash
taphound observe --project . --json
```

The Agent reads `report.foreground` and `report.layout`, confirms the Brief's
`from`/`to` Activity claims and the edge's locator against the live Layout,
and only then proposes a `generation step` bound to the session's current
snapshot. Edges marked `source` still pass through Core's live validation
during step execution; the Brief stays untrusted static context, and the live
`generation observe` snapshot bound to the session remains authoritative for
proposal hashing.

`taphound observe` is also useful when an edge's `to` Activity is genuinely
unknown and the Agent must inspect the post-action device state before
deciding whether the transition is reproducible. Because the command writes no
evidence, repeated probes during planning do not collide with the session's
revision log.
