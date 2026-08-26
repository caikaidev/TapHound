# Camera Flow Alignment Design

## Problem

The built-in External Flow `camera/photo-capture` hardcodes the AOSP Camera2
package (`com.android.camera2`) and its shutter button
(`com.android.camera2:id/shutter_button`). Real devices ship with different
camera apps: the probe device exposes `com.android.camera` with
`com.android.camera:id/shutter_button`. Any Journey that binds the built-in
flow on such a device fails during replay because the escaped package and
shutter locator never resolve.

The same mismatch applies to the confirm/done button that most camera apps
require after the shutter is pressed: the built-in flow is shutter-only and
assumes auto-accept, but many camera apps show a review screen with a separate
confirm button that must be tapped before control returns to the caller.

Today the only way to fix this is to hand-write a project-level External Flow
under `.taphound/flows/external/camera/photo-capture.json` with the correct
package and resource IDs, discovered by the user through manual `adb shell
dumpsys` / `uiautomator dump` inspection. That is error-prone and defeats the
purpose of a deterministic flow catalog.

## Solution

Add a new `taphound align camera` command that probes the connected device's
default camera app, discovers its package, launch activity, shutter button
resource ID, and (adaptively) the post-shutter confirm button resource ID,
then writes a project-level External Flow at
`.taphound/flows/external/camera/photo-capture.json` validated by the existing
`ExternalFlowSchema`.

`align` is a separate top-level command namespace. `init` stays purely
offline (skill installer); `align` is the device-aware companion that writes
project flows. The two concerns never mix.

## Integration Shape

```
taphound align
  └─ camera   Align the device's camera External Flow
```

`align camera` options:

| Flag | Purpose | Default |
|------|---------|---------|
| `--device <serial>` | Select a specific device serial | Auto-select when exactly one device is online |
| `--force` | Overwrite an existing project flow | Refuse with `ALIGN_FLOW_EXISTS` |
| `--json` | Single JSON value to stdout, skip confirm prompt | Interactive confirm prompt |

`init` is unchanged. `record`, `verify`, and `generation` continue to resolve
External Flows through the existing `ExternalFlowRegistry`; a flow written by
`align camera` is picked up by them automatically because the registry already
reads from `.taphound/flows/external/`.

## Architecture

New files:

```
src/ports/camera-probe.ts                       — CameraProbePort interface
src/adapters/camera/camera-probe-adapter.ts     — implementation using AdbPort + AndroidCliPort
src/ports/align-prompt.ts                       — AlignPromptPort interface
src/adapters/prompt/inquirer-align-prompt.ts    — Inquirer implementation
src/application/align/align-service.ts          — orchestrates probe → confirm → write
src/cli/commands/align.ts                       — Commander command tree
```

Modified files:

```
src/ports/adb.ts                                — +startActivityByIntent
src/adapters/adb/adb-adapter.ts                 — implements startActivityByIntent
src/ports/external-flow-registry.ts             — +write method
src/adapters/filesystem/external-flow-registry.ts — implements write (atomic, containment-checked)
src/cli/dependencies.ts                         — wires AlignService, CameraProbeAdapter, AlignPrompt
src/cli/program.ts                              — registers align command
src/domain/failure.ts                           — +ALIGN_* failure codes
```

### Boundary Decisions

- **`CameraProbePort`** owns camera-specific discovery: given a device, find
  the camera package, launch activity, shutter button, and confirm button. It
  depends on `AdbPort` (intent launch, foreground, tap, forceStop) and
  `AndroidCliPort` (layout dump). Camera-domain logic never leaks into generic
  ADB code, and the port is independently faked in service tests.
- **`ExternalFlowRegistry.write`** extends the existing read-only registry.
  The registry already owns `.taphound/flows/external/` for reads with
  containment and symlink checks; adding `write` makes it the single owner for
  all flow persistence, so writers cannot bypass those checks. A separate
  writer would duplicate the containment guard.
- **`AdbPort.startActivityByIntent`** is a new ADB method that runs
  `am start -W -a <action>`. The existing `launchActivity` only handles
  `-n <pkg>/<activity>` (specific component), not intent-based starts. Keeping
  all ADB command knowledge inside the ADB adapter preserves the port boundary.
- **`AlignService`** is thin orchestration: device selection (mirrors
  doctor's pattern) → probe → confirm (interactive only) → build flow → write.
  No business logic of its own; all device interaction is delegated to the
  probe port.

## Probe Protocol

### Interface

```ts
export interface CameraProbeResult {
  packageName: string;               // e.g. "com.android.camera"
  activityName: string;              // e.g. "com.android.camera.CameraActivity"
  shutterResourceId: string;         // e.g. "com.android.camera:id/shutter_button"
  shutterContentDescription?: string | undefined;
  confirmResourceId?: string | undefined;         // present only when camera shows review/confirm
  confirmContentDescription?: string | undefined;
}

export interface CameraProbePort {
  probe(input: {
    deviceSerial: string;
    signal?: AbortSignal;
  }): Promise<CameraProbeResult>;
}
```

### Algorithm

1. **Record pre-probe foreground** via `adb.foregroundComponent`. If the
   foreground is already a camera app, `forceStop` it first so the intent
   launches a fresh instance.
2. **Launch IMAGE_CAPTURE intent** via `adb.startActivityByIntent({ action:
   "android.media.action.IMAGE_CAPTURE", deviceSerial })`. `am start -W -a
   android.media.action.IMAGE_CAPTURE` lets the system pick the default
   camera app. If `startActivityByIntent` returns a non-zero exit code, fail
   with `ALIGN_CAMERA_INTENT_FAILED`. If the foreground package afterwards
   contains `resolver` or `chooser` (the system disambiguation UI), also fail
   with `ALIGN_CAMERA_INTENT_FAILED`.
3. **Wait for camera package to become foreground.** Poll
   `adb.foregroundComponent` every 500ms, timeout 8 seconds. The new
   foreground package is the device's camera package. If foreground has not
   changed after 8 seconds, fail with `ALIGN_CAMERA_NOT_LAUNCHED`.
4. **Wait for layout stability.** Call `androidCli.layout({ deviceSerial,
   packageName: cameraPackage })`, wait 1.5 seconds for the camera UI to
   render, then dump layout again. Camera apps render slowly.
5. **Find shutter.** In the initial layout, flatten the tree and filter to
   nodes with `enabled === true && clickable === true`. Prefer
   `contentDescription` keyword matches (`shutter`, `快门`, `capture`, `拍照`);
   when none exist, fall back to deterministic resource entry-name tokens.
   Disambiguate multiple accessibility matches with the same resource token
   rule. If zero matches: `ALIGN_SHUTTER_NOT_FOUND`. If still multiple:
   `ALIGN_SHUTTER_AMBIGUOUS`. If the matched node has no `resourceId`:
   `ALIGN_SHUTTER_NO_RESOURCE_ID` (v1 XML-only restriction).
6. **Tap the shutter** via `adb.tap(center)` using the element's `bounds`
   center. This captures a real photo and triggers the review/confirm state
   on cameras that have one.
7. **Wait for review UI.** Dump layout, wait 1.5 seconds, dump again. Cameras
   take time to transition from capture to review.
8. **Find confirm (adaptive).** In the post-shutter layout, use the same
   two-stage content-description then resource-entry-token lookup with
   `["done", "confirm", "accept", "ok", "save", "checkmark", "完成", "确认",
     "接受", "确定", "保存"]`. ResourceId fallback checks token priorities in
   `done`, `confirm`, `accept`, `save`, `ok` order and stops at the first
   non-empty tier. This lets a unique `done_button` win over structural
   containers such as `camera_bottom_save_cancel_container`.
   - **Found exactly one (after disambiguation)** → record `resourceId` and
     `contentDescription`. The generated flow will have 3 steps.
   - **Zero matches and camera left foreground** → camera auto-accepts. The
     generated flow will have 2 steps.
   - **Zero matches while camera remains foreground** →
     `ALIGN_CONFIRM_NOT_FOUND`; no incomplete flow is written.
   - **Still multiple after disambiguation** → `ALIGN_CONFIRM_AMBIGUOUS`.
   - **Confirm button has no resourceId** →
     `ALIGN_CONFIRM_NO_RESOURCE_ID`; v1 cannot replay it deterministically.
9. **Cleanup.** `adb.forceStop(cameraPackage)` in a `finally` block. The
   probe never taps the confirm button (no caller app is waiting for a
   result; forceStop discards any unsaved photo). If the camera auto-accepts,
   the photo is saved; this is acceptable probe overhead.

### Cleanup Invariant

All `CAMERA_*` and `SHUTTER_*` failures trigger `forceStop(cameraPackage)` in
the `finally` block when the camera package is known. If the failure happens
before the camera package is determined (e.g. `ALIGN_CAMERA_NOT_LAUNCHED`),
no forceStop is issued.

### Real Photo Capture

The probe taps the shutter on the user's device, which captures a real photo.
This is intentional: the confirm button only appears after capture, so the
probe must capture to discover it. The user is warned about this behavior in
the interactive prompt before the probe runs. ForceStop during cleanup
discards unsaved photos on cameras that require a confirm step.

## Flow Construction

`AlignService` builds an `ExternalFlow` object and validates it through
`ExternalFlowSchema` before writing.

### 3-step flow (with confirm)

```json
{
  "version": 1,
  "kind": "externalFlow",
  "name": "camera/photo-capture",
  "description": "Auto-generated by `taphound align camera` for com.android.camera on <deviceSerial>",
  "escapedPackageName": "com.android.camera",
  "expectedEscapeActivity": "com.android.camera.CameraActivity",
  "includes": [],
  "steps": [
    { "action": "wait", "expectedActivity": "com.android.camera.CameraActivity" },
    { "action": "click", "locator": { "resourceId": "com.android.camera:id/shutter_button" }, "expectedActivity": "com.android.camera.CameraActivity" },
    { "action": "click", "locator": { "resourceId": "com.android.camera:id/btn_done" }, "expectedActivity": "com.android.camera.CameraActivity" }
  ]
}
```

### 2-step flow (auto-accept, no confirm)

```json
{
  "version": 1,
  "kind": "externalFlow",
  "name": "camera/photo-capture",
  "description": "Auto-generated by `taphound align camera` for com.android.camera on <deviceSerial>",
  "escapedPackageName": "com.android.camera",
  "expectedEscapeActivity": "com.android.camera.CameraActivity",
  "includes": [],
  "steps": [
    { "action": "wait", "expectedActivity": "com.android.camera.CameraActivity" },
    { "action": "click", "locator": { "resourceId": "com.android.camera:id/shutter_button" }, "expectedActivity": "com.android.camera.CameraActivity" }
  ]
}
```

The `description` embeds the discovered package and device serial so the
generated file is self-documenting and a user inspecting it can tell which
device produced it.

### Expected Activity

The probe requires two consecutive foreground samples for a stable capture
Activity and repeats that sampling after shutter capture. `expectedEscapeActivity`,
wait, and shutter use the stable capture Activity. When a confirm step exists,
it uses the stable review Activity, allowing camera apps that transition from
a launcher/capture Activity into a separate review Activity.

## ExternalFlowRegistry.write

New method on the existing port:

```ts
export interface WriteExternalFlowInput {
  projectRoot: string;
  name: string;        // e.g. "camera/photo-capture"
  flow: ExternalFlow;
  force?: boolean | undefined;
}

export interface ExternalFlowRegistry {
  read: (input: { projectRoot: string; name: string }) => Promise<ExternalFlowRecord>;
  list: (projectRoot: string) => Promise<readonly ExternalFlowCatalogEntry[]>;
  write: (input: WriteExternalFlowInput) => Promise<{ path: string; overwritten: boolean }>;
}
```

### Write Algorithm (FileSystemExternalFlowRegistry)

1. Resolve target path: `resolve(projectRoot, EXTERNAL_FLOWS_DIR, "<name>.json")`.
2. Containment check: target must be inside `EXTERNAL_FLOWS_DIR` under the
   canonical project root (same logic as the read side).
3. Reject if the target path or any of its components (parent directories or
   the file itself) is a symlink. This matches the read side's symlink
   rejection for both directories and files.
4. If the file exists and `!force` → throw an error that the CLI maps to
   `ALIGN_FLOW_EXISTS`.
5. Validate `flow` through `ExternalFlowSchema`.
6. Assert `flow.name === name` (same guard as the read side).
7. `mkdir -p` the parent directory if it does not exist.
8. Write to a temporary file `<name>.json.tmp` via `fs.writeFile`.
9. `fs.rename` (atomic) to the final path.
10. Return `{ path: <relative path>, overwritten: <file existed> }`.

## AdbPort.startActivityByIntent

New method on the existing port:

```ts
export interface StartActivityByIntentOptions {
  action: string;         // e.g. "android.media.action.IMAGE_CAPTURE"
  deviceSerial: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface AdbPort {
  // ...existing methods...
  startActivityByIntent: (options: StartActivityByIntentOptions) => Promise<CommandResult>;
}
```

Implementation runs `adb -s <serial> shell am start -W -a <action>`. The
adapter converts a non-zero exit code or a stdout line matching
`/^Error(:| type)/m` into a `CommandResult` with a non-zero exit code so the
probe can detect launch failure uniformly with `launchActivity`.

## Failure Codes

New codes in `src/domain/failure.ts`:

| Code | Exit Code | Trigger |
|------|-----------|---------|
| `ALIGN_DEVICE_UNAVAILABLE` | 2 | No device or device offline (mirrors doctor) |
| `ALIGN_CAMERA_INTENT_FAILED` | 2 | `am start -a IMAGE_CAPTURE` non-zero exit or lands on resolver/chooser |
| `ALIGN_CAMERA_NOT_LAUNCHED` | 2 | Camera package did not become foreground within 8s |
| `ALIGN_SHUTTER_NOT_FOUND` | 2 | No element matches shutter keywords in initial layout |
| `ALIGN_SHUTTER_AMBIGUOUS` | 2 | Multiple shutter candidates, cannot disambiguate by resourceId |
| `ALIGN_SHUTTER_NO_RESOURCE_ID` | 2 | Shutter element found but has no resourceId (Compose UI) |
| `ALIGN_CONFIRM_NOT_FOUND` | 2 | Camera remains foreground but no deterministic confirm locator exists |
| `ALIGN_CONFIRM_AMBIGUOUS` | 2 | Multiple confirm candidates after shutter, cannot disambiguate |
| `ALIGN_CONFIRM_NO_RESOURCE_ID` | 2 | Confirm element exists but cannot be replayed by resourceId |
| `ALIGN_FLOW_EXISTS` | 2 | Flow file exists and `--force` not given |

All `ALIGN_*` codes use exit code 2 (config/environment). Internal errors use
exit code 4. Exit code 0 means the flow was written.

### Config Validation

`align camera` requires a valid `.taphound/config.json` in the project before
probing, validated through the existing `ConfigLoader` and `WorkspaceLayout`
guard. If config is invalid, exit with `CONFIG_INVALID` (exit code 2). This
keeps `align` consistent with `record`, `verify`, and `generation`, which all
require valid config before any device work.

## CLI Output

### Interactive Success (text)

```
Probing camera on device sample-device-1...
  Camera package:    com.android.camera
  Camera activity:   com.android.camera.CameraActivity
  Shutter button:    com.android.camera:id/shutter_button  (快门按钮)
  Confirm button:    com.android.camera:id/btn_done         (完成)

Write flow to .taphound/flows/external/camera/photo-capture.json? (Y/n) y

Wrote camera/photo-capture flow (3 steps: wait → shutter → confirm)
  Path: .taphound/flows/external/camera/photo-capture.json
```

When the camera auto-accepts (no confirm button found), the line is:

```
  Confirm button:    (none — camera auto-accepts)
```

and the summary says `2 steps: wait → shutter`.

### JSON Success

```json
{
  "status": "ok",
  "exitCode": 0,
  "flow": {
    "name": "camera/photo-capture",
    "path": ".taphound/flows/external/camera/photo-capture.json",
    "steps": 3,
    "overwritten": false
  },
  "probe": {
    "deviceSerial": "sample-device-1",
    "packageName": "com.android.camera",
    "activityName": "com.android.camera.CameraActivity",
    "shutterResourceId": "com.android.camera:id/shutter_button",
    "confirmResourceId": "com.android.camera:id/btn_done"
  }
}
```

When the camera auto-accepts, `probe.confirmResourceId` is absent.

### JSON Failure

```json
{
  "status": "error",
  "exitCode": 2,
  "failure": {
    "code": "ALIGN_SHUTTER_NOT_FOUND",
    "message": "No shutter button found in camera layout"
  }
}
```

### Output Contract

Machine-readable mode (`--json`) emits exactly one JSON value to stdout.
Progress and diagnostics go to stderr. The JSON `exitCode` matches the process
exit code. This mirrors the contract for `verify` and `generation` machine
output.

## Test Strategy

Follows existing patterns: domain unit, application with faked ports, CLI
process contract with faked binaries.

### New Test Files

| File | Scope | Pattern |
|------|-------|---------|
| `test/adapters/camera/camera-probe-adapter.test.ts` | Probe logic with mocked AdbPort + AndroidCliPort | Fake `foregroundComponent`, `startActivityByIntent`, `layout`, `tap`, `forceStop`; assert probe result + cleanup |
| `test/application/align/align-service.test.ts` | Orchestration: probe → confirm → write | Fake `CameraProbePort`, `AlignPromptPort`, `ExternalFlowRegistry`; test success, user-decline, flow-exists, `--json` skip path |
| `test/cli/align-command.test.ts` | Commander parsing, exit codes, JSON contract | Fake `CliDependencies`; single-JSON-stdout contract |
| `test/adapters/filesystem/external-flow-registry-write.test.ts` | `write` method | Real temp dirs; atomic write, containment, symlink rejection, `--force` |

The `CameraProbePort` interface itself is type-only; no runtime test file is
needed for the port.

### CameraProbeAdapter Key Cases

1. 2-step camera (auto-accept): camera leaves foreground after shutter → 2-step flow
2. 3-step camera (with confirm): post-shutter layout has one confirm → 3-step flow
3. Shutter ambiguous → `ALIGN_SHUTTER_AMBIGUOUS`
4. Shutter no resourceId → `ALIGN_SHUTTER_NO_RESOURCE_ID`
5. Camera not launched → `ALIGN_CAMERA_NOT_LAUNCHED`, cleanup runs
6. Interrupted → cleanup runs and signal propagates
7. Confirm ambiguous → `ALIGN_CONFIRM_AMBIGUOUS`
8. Confirm found but no resourceId → `ALIGN_CONFIRM_NO_RESOURCE_ID`
9. IMAGE_CAPTURE lands on resolver/chooser → `ALIGN_CAMERA_INTENT_FAILED`
10. Pre-probe foreground already a camera app → forceStop before intent
11. Camera remains foreground without confirm locator → `ALIGN_CONFIRM_NOT_FOUND`
12. Capture and review use different Activities → each step records its stable Activity

### AlignService Key Cases

1. Interactive: probe → user confirms → write → success JSON
2. Interactive: probe → user declines → no write, exit code 2
3. `--json`: probe → skip confirm → write → single JSON
4. Flow exists, no `--force` → `ALIGN_FLOW_EXISTS`
5. Flow exists, `--force` → overwrite, `overwritten: true`
6. Probe fails → propagate failure code, no write, cleanup ran

### CLI Contract Tests

- `--json` output is exactly one JSON value on stdout
- stderr carries diagnostics
- Exit code matches JSON `exitCode`
- `--device` selects the requested serial
- Missing device → `ALIGN_DEVICE_UNAVAILABLE`
- Invalid config → `CONFIG_INVALID`

### Registry Write Tests

- Atomic write (temp + rename) to a non-existent directory
- Overwrite with `--force`
- Refuse without `--force` → `ALIGN_FLOW_EXISTS`
- Reject symlink at target
- Reject path escaping `EXTERNAL_FLOWS_DIR`
- Validate `flow.name === name`
- Validate flow against `ExternalFlowSchema`

## Out of Scope

- **File/image picker alignment.** Probing picker UIs is untested and
  requires a different probe strategy (no standard intent exposes a
  deterministic picker flow). Separate future work.
- **Multi-select (picking N images).** The External Flow protocol is a fixed
  step sequence; parameterized steps would require schema, recorder,
  executor, and replay full-chain changes. Separate future work.
- **Compose UI camera apps.** v1 flows require `resourceId`-only locators
  (XML-only restriction per locked decision #17). A camera app whose shutter
  has no resourceId fails with `ALIGN_SHUTTER_NO_RESOURCE_ID`.
- **Video mode, front/back camera switching.** Probing multiple camera modes
  requires navigating UI states and does not generalize across devices. The
  probe discovers only the basic shutter + confirm.
- **Other `align` sub-commands.** `align camera` is the only sub-command in
  this design. The `align` parent is structured for future sub-commands
  (`align picker`, etc.) but they are not implemented here.
