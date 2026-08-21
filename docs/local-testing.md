# TapHound Local Testing Guide

This guide is for verifying source code, the npm tarball, and the Android device flow on the current machine or a new development machine. Run all commands from the repository root; do not run `npm publish` during the testing phase.

## 1. Prepare the Environment

Requirements:

- Node.js 22 or newer
- npm
- For device testing, additionally install the Android SDK, ADB, and Android CLI, and start an Emulator or connect a USB Device

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

All commands should exit 0, and re-rendering the brand PNGs should produce no Git diff. The latest exact test count is recorded in [`verification/taphound-v0.2-dev.1-audit.md`](verification/taphound-v0.2-dev.1-audit.md).

After building, you can inspect the CLI directly:

```bash
node dist/cli/main.js --help
```

The first line should be `Usage: taphound`, and it should list `doctor`, `record`, `verify`, `project`, `context`, `generation`, and `init`.

## 3. Test the npm Tarball

First run the full source quality gate above, then generate the tarball that will be verified on this machine:

```bash
mkdir -p /private/tmp/taphound-pack-smoke
npm pack --json \
  --pack-destination /private/tmp/taphound-pack-smoke \
  --cache /private/tmp/taphound-npm-cache
shasum -a 256 /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.2.tgz
```

Compare the digest and the size, shasum, integrity, and entryCount from `npm pack --json` against the [release-ready audit](verification/taphound-v0.2-dev.1-audit.md). Any difference means you must redo the install smoke in this section; you cannot reuse the validation conclusion from a previous machine.

Install the exact tarball into a temporary directory:

```bash
mkdir -p /private/tmp/taphound-install-smoke
npm install \
  --prefix /private/tmp/taphound-install-smoke \
  --cache /private/tmp/taphound-npm-cache \
  /private/tmp/taphound-pack-smoke/taphound-0.2.0-dev.2.tgz
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

When multiple devices are present, specify the serial directly:

```bash
node dist/cli/main.js verify \
  --project examples/taphound-android-demo \
  --config taphound.config.json \
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
