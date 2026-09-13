# TapHound Configuration Schema

`.taphound/config.json` is the committed, project-bound configuration for every
TapHound command that touches a device or the workspace. This document is the
authoritative field reference. A machine-validable JSON Schema is published at
[`schemas/config.schema.json`](schemas/config.schema.json) for editor
validation; the Zod schema in `src/domain/config.ts` remains the runtime
contract.

The config is a **strict schema**: unknown fields are rejected with
`CONFIG_INVALID` (exit code 2). TapHound never writes build inputs into the
config because it does not compile or install APKs.

```json
{
  "version": 1,
  "run": {
    "packageName": "com.example.app",
    "activity": ".MainActivity"
  },
  "idle": {
    "strategy": "hybrid",
    "pollIntervalMs": 300,
    "stablePolls": 3,
    "timeoutMs": 15000
  },
  "ui": {
    "backend": "auto",
    "snapshotTimeoutMs": 10000,
    "cacheEnabled": true
  },
  "runtime": {
    "backend": "auto"
  },
  "artifactsDir": ".taphound/build/runs"
}
```

## Field Reference

### `version` (required)

Must be the literal `1`. Bumped only on a breaking config change.

### `run` (required)

| Field | Type | Constraint |
|---|---|---|
| `run.packageName` | string | Required. Qualified Java package of the target app (`com.example.app`). Never guessed from APK filenames; TapHound fails closed when the installed package does not match. |
| `run.activity` | string | Required. Launch Activity, either relative with a leading dot (`.MainActivity`, resolved against `run.packageName`) or fully qualified (`com.example.app.ui.MainActivity`). This is only the launch entry; the app may redirect immediately. |

### `idle` (required)

Controls how every replayed or generated step waits for the screen to
stabilize. `pollIntervalMs`, `stablePolls`, and `timeoutMs` are required and
have no defaults; `strategy` defaults to `"hybrid"`.

| Field | Type | Constraint |
|---|---|---|
| `idle.strategy` | enum | `hybrid` (default), `layoutDiff`, `frameStats`, `structural` |
| `idle.pollIntervalMs` | integer | Required, positive. Sleep between polls (not the poll duration). |
| `idle.stablePolls` | integer | Required, positive. Consecutive stable polls required to declare idle. |
| `idle.timeoutMs` | integer | Required, positive. Total wait budget per idle phase before `IDLE_TIMEOUT`. Each poll consumes its own duration from this budget, so slow UI dumps require a larger value. |
| `idle.ignoreCursorBlink` | boolean | Optional. Treat layout changes that touch only editable widgets (`EditText` / `EDITABLE`) as cursor-blink noise instead of layout instability. For OEM keyboards and IME animations that keep polling busy. |
| `idle.ignoreLayoutDrift` | boolean | Optional. Treat a *constant* structured change set across consecutive polls as transient layout/geometry drift (keyboard push, ripple/focus animations) instead of content change: as long as every changed element keeps its identity (`class` + `resource-id` + `text`) across polls, those changes are ignored; the first poll with a different set counts as a real change (and the new set is adopted). Only meaningful for structured diffs (Android CLI `layout --diff`), never for signature-based sampling; combine with `ignoreCursorBlink` when a field is both moved and edited. |
| `idle.deviceProfiles` | array | Optional. Per-device overrides keyed on `match` (`manufacturer`, `model`, `sdkLevel`; at least one required, case-insensitive). Each profile can override `strategy`, `timeoutMs`, `pollIntervalMs`, `stablePolls`, `ignoreCursorBlink`, and `ignoreLayoutDrift`. Later matching profiles win. |

Strategy behavior and tuning details (early-bail thresholds, confirmation
floors, per-strategy poll accounting) are documented in
[journey-schema.md » Idle Tuning](journey-schema.md#idle-tuning). Summary:

| Strategy | Backend | Behavior |
|---|---|---|
| `hybrid` (default) | `frameStats` then `uiautomator` | Fast frame-silence detection, structural confirmation, structural fallback after 2 consecutive frame-change polls |
| `layoutDiff` | `uiautomator` | Skips frame analysis entirely; compares the layout tree directly. For continuously rendering screens (spinners, animated backgrounds). |
| `frameStats` | `gfxFrameStats` only | Pure frame timing, no structural fallback. Not recommended standalone. |
| `structural` | `uiautomator` only | Pure layout-tree comparison. |

### `ui` (optional)

| Field | Type | Constraint |
|---|---|---|
| `ui.backend` | enum | `auto` (runtime default), `system-uiautomator`, `android-cli`, `appium-uiautomator2`. `auto` probes Appium first: when a local Appium server answers `/status` on 127.0.0.1:4723, the Appium UiAutomator2 provider is used ahead of `system-uiautomator`, then `android-cli`; an unreachable server or a provider that cannot bind skips forward without error. An explicit `appium-uiautomator2` remains strict and fails closed when its provider is unavailable. |
| `ui.snapshotTimeoutMs` | integer | Optional, positive. Per-capture timeout for one UI snapshot (a single `uiautomator` dump can exceed 5 s on large trees; raise this before raising `idle.timeoutMs` when dumps are slow). |
| `ui.cacheEnabled` | boolean | Optional. `false` disables only the run-scoped observation cache; it never changes locator rules or action behavior. |

Parsing an existing config without a `ui` block adds no fields and does not
change its Generation binding hash.

### `runtime` (optional)

Selects which device runtime backend executes device work. See
[architecture/runtime-backend.md](architecture/runtime-backend.md) for the
Runtime Backend SPI, capability model, and backend adoption roadmap.

| Field | Type | Constraint |
|---|---|---|
| `runtime.backend` | enum | `auto` (default), `adb`, `mobile-mcp`. `auto` and `mobile-mcp` route device work through the Mobile MCP server; `adb` selects the ADB + Android CLI backend. |

The `TAPHOUND_RUNTIME_BACKEND` environment variable (`auto` / `adb` /
`mobile-mcp`) overrides this field per invocation, so CI and experiments can
override committed project state; an explicit environment value always wins,
and `auto` defers to the config. An invalid value in either source fails with
`CONFIG_INVALID` (exit code 2) before any command runs. See
[architecture/runtime-backend.md](architecture/runtime-backend.md#backend-selection).

The field participates in the Generation binding hash like every other config
block, so switching it mid-session requires a new generation session.

### `artifactsDir` (optional)

Default: `.taphound/build/runs`. May point outside `.taphound`, but any path
inside `.taphound` must stay under `.taphound/build` — the project-bound
authority subtree. `verify --reports` follows the same boundary.

## Recommended Configuration by App Profile

### General purpose

The example above (`hybrid`, 300 / 3 / 15000) is the recommended starting
point for most apps.

### Messaging and social apps with continuously updating UI

Apps whose list screens keep changing while in the foreground — growing unread
badges, incoming-message rows, live timestamps — can never satisfy frame-based
or layout-based stability while those updates land in the visible tree. For
these apps:

```json
"idle": {
  "strategy": "layoutDiff",
  "pollIntervalMs": 300,
  "stablePolls": 2,
  "timeoutMs": 30000
}
```

Rationale:

- `layoutDiff` skips frame counters, which never settle on screens with
  continuously arriving content.
- `timeoutMs: 30000` absorbs slow UI dumps: one `uiautomator` capture on a
  large list can take multiple seconds, and each poll's duration is charged
  against the same budget.
- If a badge or counter keeps mutating the visible layout text on every poll,
  no structural strategy can stabilize either; prefer targeting a stable
  screen state (for example after counters cap out) or accept a longer
  `timeoutMs` budget and lower `stablePolls`.
- Slow dumps alone (without layout churn) are better addressed with
  `ui.snapshotTimeoutMs` than with `idle.timeoutMs`.

### Continuously animating screens (spinners, video, animated backgrounds)

`layoutDiff` as above; pure `frameStats` only when pixel-level frame
quiescence is genuinely required and there are no structural changes.

## Generation Binding

The **entire** config (including the `idle` block and any explicit `ui`
fields) is normalized and hashed when a generation session starts, and every
`generation` subcommand re-verifies that hash. Choose the idle strategy and
timeouts before `generation start`; after start, any config change except the
idle policy requires a new session. The idle policy alone can be hot-adjusted
in place with `generation config idle --session <id> [--strategy ...]
[--poll-interval-ms ...] [--stable-polls ...] [--timeout-ms ...]`, which stores
a session-scoped override (observe, step, and finalize replay honor it) while
the original config hash stays bound. Updates are only accepted while the
session is `active` with no in-flight step, no pending confirmation, and
verification and publication both not run.

## Editor Validation

Point your editor's JSON Schema validator at
[`schemas/config.schema.json`](schemas/config.schema.json):

```jsonc
// .vscode/settings.json
{
  "json.schemas": [
    {
      "fileMatch": ["/.taphound/config.json"],
      "url": "./docs/schemas/config.schema.json"
    }
  ]
}
```

The JSON Schema mirrors the Zod contract for editor feedback; the runtime
remains authoritative and additionally enforces the `artifactsDir` workspace
boundary.
