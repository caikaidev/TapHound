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

Implementations:

| Backend | Location | Role |
|---|---|---|
| `AdbRuntimeBackend` | `src/adapters/runtime/adb-runtime-backend.ts` | ADB + Android CLI backend. Composes the existing `AdbAdapter`, `AndroidCliAdapter`, stability probe, and snapshot factory; no reimplementation. Selected with `runtime.backend: "adb"`. |
| `MobileMcpRuntimeBackend` | `src/adapters/runtime/mobile-mcp/mobile-mcp-runtime-backend.ts` | Default backend over the [Mobile MCP](https://www.npmjs.com/package/@mobilenext/mobile-mcp) server (`mcp-server-mobile`) using MCP stdio tools. `auto` resolves here. |
| `FakeRuntimeBackend` | `src/adapters/runtime/fake-runtime-backend.ts` | Benchmarks and unit tests. |

## Design rules

- **`openSession` is pure construction.** Opening a session performs no device
  I/O. The layout snapshot provider is opened lazily by the first
  `openUiSnapshots()` call, memoized for the session lifetime, and closed by
  `session.close()`. This keeps session creation free of side effects so
  callers can open sessions eagerly without injecting device probes.
- **`openUiSnapshots` options apply only to the first call.** Later calls
  return the memoized provider. A failed open evicts the memo so a retry can
  re-open.
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

## Level 0 adoption: the AdbPort bridge

Application services still speak the `AdbPort` interface (per-call
`deviceSerial`). Rather than rewriting every consumer at once, the composition
root (`createProductionDependencies` in `src/cli/dependencies.ts`) wires:

```text
AdbAdapter + AndroidCliAdapter + snapshot factory
        │
        ▼
AdbRuntimeBackend ──openSession(serial)──▶ RuntimeSession
        │
        ▼
RuntimeBackendAdbBridge (implements AdbPort)
        │  re-inserts the bound serial into each call
        ▼
RecorderService / generation / align
```

`ObserveService`, `VerifyRuntime`, `RecorderService`, `RuntimeObserver`, and
`GenerationStepExecutor` no longer use the bridge: they are the Level 1
session-first consumers and borrow a `RuntimeSession` per run through the
`RuntimeSessionOpener` port (see the roadmap below). `VerifyRuntime` feeds
its unchanged `AdbPort`-shaped helpers (`ProcessWaiter`, `ActivityWaiter`,
`LogcatCollector`, `StepRunner`) through `runtimeSessionPortViews`
(`src/adapters/runtime/session-adb-view.ts`), a serial-bound legacy port view
over one borrowed session; the view type lives in
`src/ports/runtime-session-ports.ts` so application services depend on the
factory type only. `RuntimeObserver` and `GenerationStepExecutor` open a
session per observation/step execution through the same port and pass the
views into their evidence and replay helpers; the executor binds one session
(and its snapshot provider) for the duration of a step.

The bridge (`src/adapters/runtime/runtime-backend-adb-bridge.ts`):

- caches one `RuntimeSession` per serial per process and evicts failed opens
  so retries can recover;
- maps `launchActivity` to `session.launchApp` and strips `deviceSerial` from
  every delegated call;
- routes `devices()` to `backend.listDevices()`;
- rejects `resolveLauncherActivity` (no production callers; not part of the
  SPI) and rejects `startActivityByIntent` when the session lacks the
  capability;
- delegates the synchronous `startLogcat` through a lazy `RunningCommand`
  whose `started`, `completion`, and `stop` chain to the session.

Because sessions are pure to open, the bridge adds no device calls: the
production path is behavior-identical to the direct adapter while every
device action now flows through the SPI.

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
| `auto` (default) | `MobileMcpRuntimeBackend` |
| `adb` | `AdbRuntimeBackend` |
| `mobile-mcp` | `MobileMcpRuntimeBackend` |

**Mobile MCP is the preferred runtime path (2026-09-10).** ADB is the
designated backup driver for capability gaps — notably process discovery,
which the verify path needs — and remains reachable through
`runtime.backend: "adb"` or `TAPHOUND_RUNTIME_BACKEND=adb`. The demo project
keeps pinning `adb` until the Mobile MCP capability matrix covers the core
commands.

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
- the same `RuntimeBackendAdbBridge` over the backend, so services keep the
  `AdbPort` type and capability-gated members fail closed;
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
- `verify`, `record`, `generation`, and `observe` still call capability-gated
  members (`currentActivity`, `appProcesses`, Logcat) and therefore fail
  closed under mobile-mcp with `RUNTIME_CAPABILITY_MISSING` (exit code 3);
  `observe` and `verify` fail closed through their own session-first paths,
  while `record` and `generation` still route through the bridge until their
  Level 1 orchestrators land.
- Launching uses `mobile_launch_app`, which resolves the launcher activity
  (the same semantics as `monkey -p`).
- Evidence is not portable across backends: descriptors are content-hashed
  per backend, and generation sessions/snapshots bind the backend identity,
  so a Journey verified under `adb` cannot be replayed under `mobile-mcp`
  without a fresh generation.

## Adoption roadmap

| Level | State | Description |
|---|---|---|
| 0 — bridge (current) | done | Production flows through the SPI via `RuntimeBackendAdbBridge`; services keep the `AdbPort` type. `doctor` is backend-aware and fully works under mobile-mcp. |
| 1 — session-first orchestrators | done | `ObserveService`, `VerifyRuntime`, `RecorderService`, `RuntimeObserver`, and `GenerationStepExecutor` borrow a session per run through `RuntimeSessionOpener` and fail closed on missing capability members; `VerifyRuntime` feeds its `AdbPort`-shaped helpers through `RuntimeSessionPortViews` (`src/ports/runtime-session-ports.ts`). The bridge remains for device discovery, `align`, and long-tail consumers. |
| 2 — full session typing | later | Helpers (`ProcessWaiter`, `ActionExecutor`, `LogcatCollector`, …) accept `Pick<RuntimeSession, …>`; `AdbPort` shrinks to the bridge or is deleted. |
| 3 — Mobile MCP default | done | `MobileMcpRuntimeBackend` passes the shared contract suite and `auto` resolves to it; ADB remains available through `runtime.backend: "adb"` and the environment override. |
| 4 — Mobile MCP capability completion | next | Re-check the 1.0.3 capability matrix on a real device and close the remaining gaps (process discovery is the hard one; foreground and log evidence may already be covered by `mobile_get_foreground_app` / `mobile_get_device_logs`) so `verify`, `record`, and `generation` run on the default backend without failing closed. |

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
5. ~~Flip the `auto` resolution default and update
    `docs/config-schema.md`.~~ done: `auto` now resolves to `mobile-mcp`;
    ADB stays available through `runtime.backend: "adb"`, the environment
    override, and the pinned demo project config.

## Dependency governance

- `src/domain/` and `src/application/` must not import runtime adapters or
  backend implementations; they depend on ports only.
- The SPI must not leak ADB-specific vocabulary (no `logcat`-flavored errors,
  no serial formatting rules); backend-specific concerns stay in adapters.
- Contract tests live in `test/adapters/runtime/runtime-backend.contract.ts`;
  every new backend runs the shared suite plus its own edge cases.
