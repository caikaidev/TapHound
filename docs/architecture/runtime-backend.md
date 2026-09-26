# Runtime Backend SPI

TapHound's V2 direction (see `TapHound_V2_Core_Focus_Architecture.md`) is to be
the **runtime verification engine for AI-driven Android development**: TapHound
owns state binding, risk policy, deterministic replay, and evidence, while
low-level device plumbing is delegated to interchangeable runtime backends.
The Runtime Backend SPI (`src/ports/runtime-backend.ts`) is the seam that makes
that delegation possible without changing application behavior.

## Surface

```text
RuntimeBackend                          (one per CLI process)
  descriptor                             stable identity + capabilities
  capabilities                           9 declared booleans
  listDevices(signal?)                   device discovery
  openSession({deviceSerial}) -> RuntimeSession

RuntimeSession                          (bound to one deviceSerial)
  descriptor                             the owning backend's descriptor
  isInstalled / launchApp / forceStop    app lifecycle
  currentActivity / foregroundComponent  activity state
  appProcesses / windowTopology          process + window state
  tap / longClick / swipe / back / inputText   deterministic actions
  startLogcat / dumpLogcat               log evidence
  captureScreenshot                      visual evidence
  openUiSnapshots()                      lazy, memoized layout provider
  annotatedScreens?                      capability-gated (adb only today)
  startActivityByIntent?                 capability-gated (adb only today)
  uiStability                            required idle probe
  close()                                releases the snapshot provider
```

Text input: `adb shell input text` cannot type non-ASCII characters (the
device-side `KeyCharacterMap` resolves them to no events and the command
fails). When the input text contains non-ASCII characters, the ADB backend
delivers it through the [mobilenext devicekit](https://github.com/mobile-next/devicekit-android)
app instead: it sets the clipboard by broadcast, pastes into the focused
element with `KEYCODE_PASTE`, and clears the clipboard again. Install the
devicekit app on the device to record or replay non-ASCII `inputText` steps.

Implementations:

| Backend | Location | Role |
|---|---|---|
| `AdbRuntimeBackend` | `src/adapters/runtime/adb-runtime-backend.ts` | ADB + Android CLI backend. Composes the existing `AdbAdapter`, `AndroidCliAdapter`, stability probe, and snapshot factory; no reimplementation. Selected by `runtime.backend: "auto"` or `"adb"`. |
| `MobileMcpRuntimeBackend` | `src/adapters/runtime/mobile-mcp/mobile-mcp-runtime-backend.ts` | Explicit alternative over the [Mobile MCP](https://www.npmjs.com/package/@mobilenext/mobile-mcp) server (`mcp-server-mobile`) using MCP stdio tools. |
| `FakeRuntimeBackend` | `src/adapters/runtime/fake-runtime-backend.ts` | Unit tests. |

## Design rules

- **`openSession` is pure construction.** Opening a session performs no device
  I/O. The layout snapshot provider is opened lazily by the first
  `openUiSnapshots()` call, memoized for the session lifetime, and closed by
  `session.close()`. This keeps session creation free of side effects so
  callers can open sessions eagerly without injecting device probes.
- **`openUiSnapshots` options apply only to the first call.** Later calls
  return the memoized provider. A failed open evicts the memo so a retry can
  re-open.
- **Device-side layout temp files are self-healing.** Every UIAutomator-based
  capture writes a uniquely named XML file under
  `/data/local/tmp/taphound-uiautomator-*.xml` and removes it best-effort in a
  `finally` block (5s timeout). Because a killed process or a timed-out dump
  can still leak a file, providers also sweep the whole prefix glob: the
  system-uiautomator factory sweeps once during `open()` and again on
  `close()`, and `AndroidCliAdapter` sweeps once per instance before its
  first layout read. Sweeps are best-effort (errors swallowed, 5s timeout);
  they only ever delete the `taphound-uiautomator-` prefix, never unrelated
  files in `/data/local/tmp`. A concurrent capture on the same device may
  fail closed with `UI_SNAPSHOT_FAILED` if a sweep removes its in-flight
  file; device work is serialized per Case, so this only affects
  deliberately concurrent host processes.
- **Capability-gated members fail closed.** `annotatedScreens` and
  `startActivityByIntent` are `undefined` on backends that lack the
  capability. Callers must check before use; a missing member is a hard error
  (`RUNTIME_CAPABILITY_MISSING`, exit code 3) naming the
  `runtime.backend` / `TAPHOUND_RUNTIME_BACKEND` escape hatches, never a
  silent fallback. The error factory lives in
  `src/ports/runtime-capability.ts` so application services can reject
  without importing adapters.
- **Call session members as property calls.** Implementations may declare
  capability-gated members as prototype methods (`AdbRuntimeSession`) or as
  bound instance fields (`MobileMcpRuntimeSession`). Consumers must invoke
  them directly on the session (`session.dumpLogcat({...})`) after the
  `undefined` guard, never as detached functions, or method-style
  implementations lose their `this` binding.
- **Descriptors are content-hashed.** `configSha256` covers identity,
  adapter version, and capabilities. Generation binds descriptors the same way
  it binds UI backend descriptors, so a backend change invalidates sessions
  deterministically.
- **`uiStability` is required.** Every backend that can capture layouts can
  implement at least layout-diff stability, so idle waiting is never
  capability-fragmented.

## Composition: every consumer borrows a session

The composition root (`createProductionDependencies` in
`src/cli/dependencies.ts`) builds one `RuntimeBackend` and hands its
`RuntimeSessionOpener` to every device consumer:

```text
AdbAdapter + AndroidCliAdapter + snapshot factory
        │
        ▼
AdbRuntimeBackend ──openSession(serial)──▶ RuntimeSession
        │                                        │
        │ listDevices()                          ▼
        ▼                          runtimeSessionPortViews(session)
doctor / align device listing      (serial-bound AdbPort-shaped views)
```

`ObserveService`, `VerifyRuntime`, `RecorderService`, `RuntimeObserver`,
`GenerationStepExecutor`, `GenerationAppPreparer`, and `CameraProbeAdapter`
borrow a `RuntimeSession` per run, observation, step, launch, or probe through
the `RuntimeSessionOpener` port (`withRuntimeSession` borrows one and always
closes it). Their `AdbPort`-shaped helpers (`ProcessWaiter`, `ActivityWaiter`,
`LogcatCollector`, `StepRunner`, `ActionExecutor`) receive
`runtimeSessionPortViews` (`src/adapters/runtime/session-adb-view.ts`), a
serial-bound view over the borrowed session whose capability-gated members
fail closed with `RUNTIME_CAPABILITY_MISSING`; the view type lives in
`src/ports/runtime-session-ports.ts` so application services depend on the
factory type only. Device-wide probes need no session: `doctor` and `align`
list devices through `RuntimeBackend.listDevices`, and `doctor`'s install
check borrows a session per call. Idle device profiles read `deviceIdentity`
from the observing session's own view.

## Backend selection

The CLI selects the backend per invocation (`src/cli/runtime-selection.ts`)
from two sources with fixed precedence:

1. `TAPHOUND_RUNTIME_BACKEND` environment variable — an explicit value
   (`adb` / `mobile-mcp`) always wins, so CI and experiments can override
   committed project state;
2. `runtime.backend` in `config.json` — the persisted project choice, read
   before command parsing (the entry resolves the `--project`/`--config`
   arguments with the same defaults the commands use).

| Effective choice | Resolves to |
|---|---|
| `auto` (default) | `AdbRuntimeBackend` |
| `adb` | `AdbRuntimeBackend` |
| `mobile-mcp` | `MobileMcpRuntimeBackend` |

**ADB is the complete default runtime path.** `auto` resolves to ADB so
`observe`, `verify`, `record`, `generation`, `align`, and `doctor` have the
required process, Activity, Logcat, and intent capabilities. UI snapshot
selection is independent: `ui.backend=auto` probes Appium UiAutomator2 first,
then system UIAutomator, then Android CLI. Mobile MCP remains available through
an explicit `runtime.backend: "mobile-mcp"` or environment override and fails
closed when a command needs a capability it does not expose.

An invalid value in either source fails with `CONFIG_INVALID` (exit code 2)
before any command runs; a missing config or a config without `runtime.backend`
simply falls back to `auto`.

Under `mobile-mcp` the composition root wires:

- `SharedSessionRuntimeBackend` (`src/adapters/runtime/shared-session-runtime-backend.ts`)
  memoizing one `RuntimeSession` (and therefore one MCP server process) per
  device serial per CLI process;
- session-backed facades for screenshots, UI stability, and layout snapshots
  (`src/adapters/runtime/session-backed-ports.ts`);
- `FailClosedAnnotatedScreenResolver` for the capability-gated annotated
  fallback;
- a `close()` hook on the dependencies so `src/cli/main.ts` releases every
  memoized session (and its MCP server process) after the command exits.

## Mobile MCP backend

`MobileMcpRuntimeBackend` declares:

| Capability | Value | Notes |
|---|---|---|
| `layoutSnapshot` | yes | `mobile_list_elements_on_screen` |
| `screenshot` | yes | `mobile_save_screenshot` |
| `annotatedScreens` | no | annotated fallback fails closed |
| `frameStatsIdle` | no | idle uses layout-diff stability |
| `logs` | no | no Logcat evidence |
| `processDiscovery` | no | no `appProcesses` |
| `windowTopology` | no | |
| `intentStart` | no | no `startActivityByIntent` |
| `foregroundActivity` | no | no `currentActivity` / `foregroundComponent` |

Known limitations:

- `doctor` is fully adapted: it checks `mcp-server-mobile --version` instead of
  the Android CLI, discovers devices through `mobile_list_available_devices`,
  checks installation through `mobile_list_apps` (which enumerates
  launcher-visible apps), and runs the permission probe through the MCP
  screenshot path. `ui.backend=appium-uiautomator2` is rejected under
  mobile-mcp.
- A missing `mcp-server-mobile` binary is a coded `ENVIRONMENT_MISSING_TOOL`
  failure (exit code 3), not a bare spawn error: `McpToolClient` connection
  failures and the doctor probe share one remediation message that names the
  `npm install -g @mobilenext/mobile-mcp` install command and the
  `runtime.backend` / `TAPHOUND_RUNTIME_BACKEND` escape hatch to `adb`.
- `McpToolClient` forwards `TMPDIR` to the server process. The MCP SDK spawns
  servers with a minimal inherited environment that omits `TMPDIR`, so a
  1.0.3+ server would otherwise treat `/tmp` as the only allowed temp
  directory and reject TapHound's `os.tmpdir()`-based screenshot paths with
  `"is not in the list of allowed directories"`.
- `verify`, `record`, `generation`, and `observe` call capability-gated
  members (`currentActivity`, `appProcesses`, Logcat) and therefore fail
  closed under mobile-mcp with `RUNTIME_CAPABILITY_MISSING` (exit code 3)
  through their own session-first paths; `align` fails closed the same way
  when its camera probe needs `startActivityByIntent`.
- Launching uses `mobile_launch_app`, which resolves the launcher activity
  (the same semantics as `monkey -p`).
- Evidence is not portable across backends: descriptors are content-hashed
  per backend, and generation sessions/snapshots bind the backend identity,
  so a Journey verified under `adb` cannot be replayed under `mobile-mcp`
  without a fresh generation.

## Adoption roadmap

| Level | State | Description |
|---|---|---|
| 0 — bridge adoption | removed | Production first flowed through the SPI via an `AdbPort` bridge; it was deleted once every consumer borrowed sessions. `doctor` is backend-aware and fully works under mobile-mcp. |
| 1 — session-first orchestrators | done | Every device consumer (including `align`, `doctor`'s install probe, and the generation app preparer) borrows a session per run through `RuntimeSessionOpener` and fails closed on missing capability members; `AdbPort`-shaped helpers receive `RuntimeSessionPortViews` (`src/ports/runtime-session-ports.ts`). |
| 2 — full session typing | later | Helpers (`ProcessWaiter`, `ActionExecutor`, `LogcatCollector`, …) accept `Pick<RuntimeSession, …>`; `AdbPort` shrinks to the bridge or is deleted. |
| 3 — complete default runtime | done | `MobileMcpRuntimeBackend` passes the shared contract suite, while `auto` resolves to the capability-complete ADB runtime. Mobile MCP remains explicitly selectable. |
| 4 — Mobile MCP capability completion | blocked | 1.0.3 audit confirmed no new capability can be enabled: `mobile_get_foreground_app` returns package name only (no Activity), `mobile_get_device_logs` is non-historical, and no process-list tool is exposed even though `AndroidRobot.listRunningProcesses` exists. `verify`/`record`/`generation` keep the ADB execute path; re-check on each upstream server release and flip once process discovery, foreground Activity, and logcat dump are available. |

## Phase 2 flip checklist

Switching the default runtime to Mobile MCP must remain a wiring and config
change, not a rewrite:

1. ~~Add `"mobile-mcp"` to `RuntimeBackendIdSchema` and the resolution map in
   `src/domain/runtime.ts`.~~ done
2. ~~Implement `MobileMcpRuntimeBackend` (MCP client over stdio; open/close
   lifecycle maps to the server process).~~ done, validated on a real device
3. ~~Run it through `describeRuntimeBackendContract` plus capability-specific
   suites; gate features (annotated fallback, intent start, window topology)
   on declared capabilities.~~ done
4. ~~Plumb `config.runtime.backend` into the composition root (config is loaded
   per command today, so selection must move to service construction or a
   lazy resolver).~~ done: the CLI entry resolves the invocation's
   `--project`/`--config` before dependency construction and combines the
   config choice with the `TAPHOUND_RUNTIME_BACKEND` override
   (`src/cli/runtime-selection.ts`).
5. Keep `auto` on the capability-complete ADB runtime until an alternative can
   support the full deterministic verification contract. UI `auto` independently
   prefers Appium UiAutomator2.

## Dependency governance

- `src/domain/` and `src/application/` must not import runtime adapters or
  backend implementations; they depend on ports only.
- The SPI must not leak ADB-specific vocabulary (no `logcat`-flavored errors,
  no serial formatting rules); backend-specific concerns stay in adapters.
- Contract tests live in `test/adapters/runtime/runtime-backend.contract.ts`;
  every new backend runs the shared suite plus its own edge cases.
