---
name: taphound-flash
description: >-
  Quick smoke check of an installed Android app right after an AI coding
  change: cold-launch it, tap through a few elements by resource id, text,
  or content description, and assert what must appear, using only adb and
  Node.js (no TapHound CLI). Use after coding and installing a build, before
  deeper verification. It is not evidence: prove a change with
  taphound-verify-change.
compatibility: Requires Node.js 18+, adb, one online and unlocked Android device, and the app already built and installed.
metadata:
  author: TapHound
  version: "1.0"
---

# Flash smoke check

Catch obvious breakage in seconds: the app crashes on launch, a screen no
longer opens, a button vanished, a result never shows. Run it after every
meaningful change while coding. A passing flash run proves nothing about
correctness; before calling a change done, use `taphound-verify-change`.

Flash does not build or install the app. Install the fresh build first.

## 1. Write a plan

Keep it to the path the change touched, usually 3 to 10 steps. Save it
anywhere (for example `flash-plan.json`); `templates/flash-plan.example.json`
shows the demo app's search flow.

```json
{
  "version": 1,
  "packageName": "com.example.app",
  "activity": ".MainActivity",
  "steps": [
    { "action": "tap", "target": { "id": "open_search" } },
    { "action": "type", "text": "hello" },
    { "action": "expect", "target": { "text": "Results" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `packageName` | installed application id (`applicationId`, not the manifest `package`) |
| `activity` | optional launch Activity (`.Main` or fully qualified); omit to use the launcher entry |
| `device` | optional serial; otherwise exactly one device must be online |
| `timeoutMs` | how long `tap` and `expect` wait for their target (default 10000) |
| `settleTimeoutMs` | how long the UI may keep changing after an action (default 5000) |

| Step | Does |
|---|---|
| `{"action":"tap","target":T}` | waits for T, then taps it |
| `{"action":"type","text":"..."}` | types printable ASCII into the focused field (tap the field first) |
| `{"action":"back"}` | presses Back |
| `{"action":"wait","ms":500}` | sleeps; prefer `expect` |
| `{"action":"expect","target":T,"absent":false,"timeoutMs":3000}` | waits until T is shown (or gone with `"absent": true`) |
| `{"action":"expectActivity","activity":".SearchActivity"}` | waits until that Activity is in front |

A target `T` has exactly one of `id` (resource id without the `id/`
prefix), `text`, or `desc` (content description), matched exactly within
the app's own UI. Take them from the code you just changed: layout XML
`android:id`, visible strings, or `contentDescription`. Compose nodes expose
`testTag` as a resource id only when `testTagsAsResourceId` is enabled;
otherwise target their text or content description.

## 2. Run it

```bash
node <this-skill>/scripts/flash.mjs run flash-plan.json --out <evidence-dir>
```

The script force-stops and launches the app (waking the screen and
dismissing a non-secure lock screen), runs the steps, and prints one JSON
result. After each action it waits for the UI to settle and checks the app
is still running and in front.

| Exit | `status` | Meaning |
|---|---|---|
| 0 | `passed` | every step passed; `evidence.screenshot` is the final screen |
| 1 | `failed` | `failure.code` names what broke at `failure.stepIndex` |
| 2 | `error` | the plan or command line is invalid; nothing touched the device |
| 3 | `error` | environment: adb missing, no single online device, app not installed, device locked |

## 3. Read a failure

Open `evidence.screenshot` and `evidence.hierarchy` (the UI dump at the
failure) before changing anything.

| `failure.code` | Usually means |
|---|---|
| `APP_CRASHED` | the process died; read `evidence.crashLog` |
| `LAUNCH_FAILED`, `APP_NOT_VISIBLE` | wrong `activity`, a startup crash, or something covering the app |
| `TARGET_NOT_FOUND` | the element is gone, renamed, or not on this screen yet |
| `TARGET_AMBIGUOUS` | several elements match; use a more specific target |
| `NOT_CLICKABLE`, `TARGET_DISABLED` | nothing clickable handles the tap, or it is disabled |
| `EXPECT_FAILED`, `ACTIVITY_MISMATCH` | the change did not produce the expected screen |
| `UNSETTLED` | the UI never stopped changing (animation, polling); raise `settleTimeoutMs` |
| `LEFT_APP` | the action opened another app or a system dialog |

Fix the code or the plan, reinstall, and run again. Never weaken an
`expect` just to make the run pass; if the expected behavior changed on
purpose, say so.

## Rules

- Flash never guesses: no coordinates, no visual matching. A missing or
  ambiguous target fails the step.
- A tap lands on the matched element's own center and must be handled by
  that element or its nearest clickable ancestor, as in TapHound Replay.
- It only drives the app under test; a flow through the camera or a picker
  belongs in a TapHound Journey with a `bridge` step.
- Report flash results as a smoke check. They are not a Verdict, Baseline,
  or Journey, and they cannot mark a Case done.
