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
  capabilities                           8 declared booleans
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
| `AdbRuntimeBackend` | `src/adapters/runtime/adb-runtime-backend.ts` | Production default. Composes the existing `AdbAdapter`, `AndroidCliAdapter`, stability probe, and snapshot factory; no reimplementation. |
| `MobileMcpRuntimeBackend` | `src/adapters/runtime/mobile-mcp/mobile-mcp-runtime-backend.ts` | Opt-in backend over the [Mobile MCP](https://www.npmjs.com/package/@mobilenext/mobile-mcp) server (`mcp-server-mobile`) using MCP stdio tools. |
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
  capability. Callers must check before use; a missing member is a hard error,
  never a silent fallback.
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
DoctorService / RecorderService / VerifyRuntime / generation / observe / align
```

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

The composition root selects the backend per CLI process from the
`TAPHOUND_RUNTIME_BACKEND` environment variable (`src/cli/runtime-selection.ts`):

| Value | Resolves to |
|---|---|
| unset / `auto` | `adb` (the Mobile MCP default is a later, separate decision) |
| `adb` | `AdbRuntimeBackend` |
| `mobile-mcp` | `MobileMcpRuntimeBackend` |

An invalid value fails with `CONFIG_INVALID` (exit code 2) before any command
runs. Selection is intentionally environment-based for now: config is loaded
per command, while the backend must be fixed when dependencies are constructed.
`config.json` keeps the reserved `runtime.backend` key (`auto` / `adb`), which
still resolves to `adb` today; moving the selection into config is a later
step of the flip checklist.

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
- `verify`, `record`, `generation`, and `observe` still call capability-gated
  members (`currentActivity`, `appProcesses`, Logcat) through the bridge and
  therefore fail closed under mobile-mcp; running them requires the Level 1
  session-first orchestrators on the roadmap.
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
| 1 — session-first orchestrators | next | `VerifyRuntime`, `RecorderService`, `RuntimeObserver`, and `GenerationStepExecutor` open a session per run and pass it down; the bridge remains for device discovery and long-tail consumers. |
| 2 — full session typing | later | Helpers (`ProcessWaiter`, `ActionExecutor`, `LogcatCollector`, …) accept `Pick<RuntimeSession, …>`; `AdbPort` shrinks to the bridge or is deleted. |
| 3 — Mobile MCP default | Phase 2 | `MobileMcpRuntimeBackend` passes the same contract suite; `auto` resolves to it. The backend and env selection are done; the default flip is pending. |

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
4. Plumb `config.runtime.backend` into the composition root (config is loaded
   per command today, so selection must move to service construction or a
   lazy resolver). Interim: `TAPHOUND_RUNTIME_BACKEND` env selection is wired
   at the composition root; moving it into config is still open.
5. Flip the `auto` resolution default and update
   `docs/config-schema.md`.

## Dependency governance

- `src/domain/` and `src/application/` must not import runtime adapters or
  backend implementations; they depend on ports only.
- The SPI must not leak ADB-specific vocabulary (no `logcat`-flavored errors,
  no serial formatting rules); backend-specific concerns stay in adapters.
- Contract tests live in `test/adapters/runtime/runtime-backend.contract.ts`;
  every new backend runs the shared suite plus its own edge cases.
