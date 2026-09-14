# TapHound Local Testing Guide

This guide is for verifying source code, the npm tarball, and the Android device flow on the current machine or a new development machine. Run all commands from the repository root; do not run `npm publish` during the testing phase.

## 1. Prepare the Environment

Requirements:

- Node.js 22 or newer
- npm
- For device testing, additionally install the Android SDK, ADB, and Android CLI, and connect an API 26+ device
- For the optional Appium backend, run a loopback-only Appium server with the UiAutomator2 driver; TapHound never sends credentials to or permits a remote endpoint

Clone and install locked dependencies:

```bash
git clone git@github.com:caikaidev/TapHound.git
cd TapHound
npm ci
```

Prepare, validate, and register the local CLI in one command:

```bash
npm run dev:setup
```

This runs the tests, type-checker, linter, build, built-CLI smoke test,
`npm link`, and a final check through the registered `taphound` command. After
it passes, commands such as the following use the current checkout:

```bash
taphound doctor --project /path/to/android-project
```

Run `npm ci` separately after cloning or whenever locked dependencies change;
`dev:setup` intentionally does not reinstall dependencies on every run.

## 2. Run Source Tests

Run only a single test file:

```bash
npm test -- test/domain/journey.test.ts
```

Run the full source quality gate:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run brand:render
git diff --exit-code -- assets/brand/png
```

All commands should exit 0, and re-rendering the brand PNGs should produce no Git diff. Historical test counts in release audits are not a substitute for the current command result.

After building, you can inspect the CLI directly:

```bash
node dist/cli/main.js --help
```

The first line should be `Usage: taphound`, and it should list `doctor`, `record`, `verify`, `contract`, `observe`, `project`, `context`, `journey`, `generation`, `knowledge`, `benchmark`, `init`, `align`, `impact`, `verify-changes`, and `ui-cache`.

## 3. Test the npm Tarball

First run the full source quality gate above, then generate the tarball that will be verified on this machine:

```bash
mkdir -p /private/tmp/taphound-pack-smoke
npm pack --json \
  --pack-destination /private/tmp/taphound-pack-smoke \
  --cache /private/tmp/taphound-npm-cache
shasum -a 256 /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.6.tgz
```

Record the digest, size, shasum, integrity, and entryCount from `npm pack --json`
in the audit for the exact release candidate. Do not compare a `dev.6` tarball
against the historical `dev.1` audit. Any difference between machines means
you must redo the install smoke in this section.

Install the exact tarball into a temporary directory:

```bash
mkdir -p /private/tmp/taphound-install-smoke
npm install \
  --prefix /private/tmp/taphound-install-smoke \
  --cache /private/tmp/taphound-npm-cache \
  /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.6.tgz
/private/tmp/taphound-install-smoke/node_modules/.bin/taphound --help
test ! -e "/private/tmp/taphound-install-smoke/node_modules/.bin/$(printf 'a\160r')"
```

Both the help command and the last negative check should exit 0. npm 11 does not run `prepublishOnly` for `npm publish <tgz>`, so the full source quality gate and the exact-tarball smoke are both independent required steps before publishing.

## 4. Check the Android Environment

List online devices:

```bash
adb devices -l
```

Run the environment diagnostics:

```bash
node dist/cli/main.js doctor \
  --project examples/taphound-android-demo \
  --json
```

When there are no online devices, exit code 3 and `DEVICE_UNAVAILABLE` are acceptable; this does not count as passing real-device acceptance. When multiple devices are online, subsequent commands must explicitly select one using `--device <serial>`.

## 5. Run the Android Demo Journey

TapHound does not compile or install the APK. Before running real-device acceptance, install the demo app onto the device first:

```bash
cd examples/taphound-android-demo
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
cd ../..
```

When exactly one device is online, run the repository acceptance entry:

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:device
```

This command verifies a full Replay of an existing Journey. The generation protocol has a separate real-device acceptance entry, which creates a Project Context, executes `generation start → observe → step → finalize`, and requires the final state to be `verified`:

```bash
TAPHOUND_ACCEPTANCE_DEVICE=1 npm run acceptance:generation
```

Both entries are explicit opt-in; passing the normal test suite is not evidence that real-device Replay or Generation acceptance passed. You must run `npm run build` first.

The Mobile MCP runtime backend is an explicit alternative to the default ADB
runtime and has its own opt-in acceptance entry. It requires
`mcp-server-mobile` on `PATH`, an
online device with the demo app installed, and runs `doctor` end to end through
the real MCP server (device discovery, app installation, and the screenshot
permission probe). The demo project config pins `runtime.backend: "adb"` so
the Replay and Generation acceptance entries above keep exercising the ADB
path; the Mobile MCP entry selects its backend through the environment:

```bash
TAPHOUND_MOBILE_MCP_DEVICE=1 npm run acceptance:mobile-mcp
```

The demo contains XML View, pure Compose, and hybrid View/`ComposeView`
surfaces. Compose test tags are exported as resource IDs so provider acceptance
can verify structural capture, live locator resolution, and ADB injection. To
guarantee that device code matches the checkout, uninstall before reinstalling:

```bash
adb uninstall dev.taphound.demo
adb install app/build/outputs/apk/debug/app-debug.apk
```

Select a backend in `.taphound/config.json` with `ui.backend`. `auto` probes
the local Appium UiAutomator2 provider first, then System UIAutomator, and
finally Android CLI; it probes only while opening the provider and never
switches after binding. An explicit Appium configuration is strict and fails
closed if the provider is unavailable:

```json
{"ui":{"backend":"appium-uiautomator2","snapshotTimeoutMs":10000,"cacheEnabled":true}}
```

Set `cacheEnabled` to `false` for cache-equivalence tests. Authoritative
evidence and post-mutation reads remain fresh in both modes.

The optional persistent screen/flow index is non-authoritative and lives at
`.taphound/build/cache/ui/`. It stores only resource-ID contracts, semantic
hashes, and Flow verification receipts; it never stores page source, page
text, screenshots, or reusable tap coordinates. Inspect or remove it without
affecting Journeys, reports, or generation evidence:

```bash
node dist/cli/main.js ui-cache status --project examples/taphound-android-demo --json
node dist/cli/main.js ui-cache clear --project examples/taphound-android-demo --yes --json
```

When Appium is explicitly configured, start its local loopback server before
running `doctor`; doctor reports the detected Appium server/UiAutomator2 driver
versions and the expected startup command:

```bash
appium --address 127.0.0.1 --port 4723
node dist/cli/main.js doctor --project examples/taphound-android-demo --json
```

When multiple devices are present, specify the serial directly:

```bash
node dist/cli/main.js verify \
  --project examples/taphound-android-demo \
  --config .taphound/config.json \
  --journey .taphound/journeys/search.json \
  --device emulator-5554 \
  --json
```

Replace `emulator-5554` with the target serial returned by `adb devices -l`. The report is written to `examples/taphound-android-demo/.taphound/build/runs/` and always contains `report.json` and `summary.txt`; screenshots, full Logcat, and step logs are provided depending on the run phase and collection results, and collection failures are recorded as secondary errors.

TapHound uses its own in-repo JSON Journey; do not replace it with Android CLI's XML Journey.

## 6. What to Record When Tests Fail

Cross-machine validation should retain at minimum:

- Git commit SHA, Node/npm/Android CLI versions, and the device serial
- The failing command and its exit code
- The `report.json`, `summary.txt`, and any necessary logs from the corresponding run directory
- Whether the failure can be reliably reproduced on the same commit

Do not commit tokens, OTPs, device privacy data, or other credentials.

## 7. Vendor-Specific Device Notes

Customized ROMs differ in UI idle behavior. Two seams exist for device-specific
tuning (see `docs/config-schema.md`):

- `idle.ignoreCursorBlink` — treats structural layout changes that touch only
  editable widgets (`EditText` / `EDITABLE`) as cursor-blink noise.
- `idle.deviceProfiles` — per-device overrides matched on `manufacturer`,
  `model`, and/or `sdkLevel` (case-insensitive), each able to override
  `strategy`, `timeoutMs`, `pollIntervalMs`, `stablePolls`, and
  `ignoreCursorBlink`. Later matching profiles win.

Known observations on Samsung devices (`SM-A5560`, Android 14, One UI):

- Opening an editable field opens the Software Keyboard and keeps the layout
  busy for a long stretch; the keyboard also pushes sibling controls
  (e.g. a submit button) around, so `ignoreCursorBlink` alone does not cover
  the whole IME animation. Two complementary seams handle this:
  `ignoreCursorBlink` (editable-only changes) and `ignoreLayoutDrift`
  (a constant change set across polls = geometry drift; see
  `docs/config-schema.md`). The demo config ships a `samsung` profile enabling
  both and raising `timeoutMs`.
- The Android CLI `layout` service can transiently fail with
  "Unrecognized response from instrumentation server" on these devices;
  TapHound surfaces that as `UI_SNAPSHOT_INVALID` at capture time. Restarting
  `adb` or the Instrumentation Server may recover it; the failure is
  environment-only and reproduces independently of TapHound changes.
- Devices where both the Android CLI `layout` service and the shell
  `uiautomator` service fail (e.g. some Android 16 devices) can still run
  through `ui.backend=appium-uiautomator2` with a local Appium server
  (`appium --address 127.0.0.1 --port 4723`, UiAutomator2 driver installed).
  The Appium provider does its own stability sampling (page-source hash
  diff), because an active Appium session owns the UiAutomation connection
  and shell `uiautomator dump` then fails with a session conflict; the demo
  config keeps this backend pinned for that reason. A device reboot clears a
  stuck "UiAutomationService already registered" framework state.
