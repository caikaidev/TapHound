# Android Project Runtime (APR)

Version: v0.2

Status: Draft

Target Platform:

- macOS
- Android CLI
- Android Studio (Latest Stable)

---

# 1. Background

AI can already complete a large amount of Android code writing work.

However, after code changes are complete, developers still need to manually perform many repetitive operations:

- Build
- Run
- Open a specific page
- Enter test data
- View results
- View logs

These steps are repeated many times every day.

The goal of APR is not to replace Android CLI.

Instead, on top of Android CLI, it provides a repeatable Runtime for Android projects.

---

# 2. Goal

The first phase solves only one problem:

> After AI modifies the code, it can automatically complete a single real functional verification.

For example:

```
Modify code

↓

Run App

↓

Enter the search page

↓

Input hello world

↓

Screenshot

↓

Export logs

↓

End
```

The first phase does not introduce AI reasoning.

It only ensures the process executes stably.

## 2.1 Core Positioning and Value Proposition

APR is a **fully self-developed, deterministic verification tool that does not rely on AI to participate in execution**.

Core scenario: after a developer / AI completes a code change for a requirement, it needs to perform a **repeatable and trustworthy** regression verification of that change.

Verification relies on two types of signals, used in combination:

1. **Precise operation trigger results** — whether the click hit the target, whether the page navigated as expected
2. **Whether business logs match expectations** — whether the logs on the key path appear with the expected content within the expected time window

Combining the two is to rule out false positives where "the process ran to completion, but actually ran incorrectly."

### 2.1.1 Relationship with the Official Android CLI Journey

Android CLI itself already provides Journey capability ([Android CLI support for Journeys](https://developer.android.com/tools/agents/android-cli/journeys)), but the two design philosophies are completely different, and this must be clarified here to avoid the misunderstanding of "reinventing the wheel":

| | Official Journey | APR Journey |
|---|---|---|
| Locating approach | AI vision + reasoning, real-time judgment | resourceId / text / contentDescription, fixed matching |
| Each execution | Always requires AI reasoning | Pure deterministic replay, no model invocation |
| Cost | Consumes model tokens on every run | Record once, then replay at near-zero cost |
| Stability | Depends on model judgment, with drift risk | Fixed path, results are reproducible and comparable |
| Assertion approach | Natural language description, judged by AI | Pre-recorded structured assertions (navigation target / log matching), deterministic judgment |
| Applicable scenarios | Exploratory verification, complex semantic judgment | High-frequency regression verification, CI, scenarios requiring a stable baseline |

**The core selling point of APR is determinism, repeatability, and zero AI token consumption, suitable as the high-frequency self-regression verification method that "AI runs every time after changing code"**, rather than replacing the exploratory verification capability of the official Journey. The two can coexist: the official Journey is suitable for "exploring whether this feature is correct," while APR is suitable for "confirming that this change did not break known paths."

---

# 3. Scope

## Included

- Android CLI integration
- Journey Replay
- Journey Recorder
- Screenshot
- Logcat
- Verification Report
- Assertion mechanism (navigation / log)
- Wait strategy based on Layout Diff

## Excluded

- AI automatic exploration
- OCR
- Vision (except the official `screen resolve` fallback locating)
- DFS
- Android Studio Plugin
- Windows
- Linux
- CI
- Multi-device concurrency
- Auto-repair Journey
- Auto-generate assertion content (assertions still need to be explicitly specified by a human / AI at the recording stage)

---

# 4. Development Constraints

## Platform

Only supported:

- macOS

Other platforms will be supported later.

The first run on macOS involves system dialogs such as USB debugging authorization and screen recording permission. These permission issues interrupt the automation flow and are known limitations that need to be prompted to the developer in advance during the environment preparation stage.

---

## Android CLI Dependency Boundary

APR depends on the official Android CLI ([developer.android.com/tools/agents/android-cli](https://developer.android.com/tools/agents/android-cli)), but it must be clarified: **Android CLI does not provide complete interactive execution capability**, and APR's dependency on it is split into two parts:

### 4.1 Provided by Android CLI

| Capability | Corresponding command | Purpose |
|---|---|---|
| Deploy a built APK | `android run --apks=<path>` | Install and launch the App during the Run stage. **Note: this command does not perform any build step**, the APK must be built by Gradle in advance |
| Get artifact path | `android describe` | Locate the APK path output by Build, for use by `run` |
| Get UI Layout | `android layout [--diff]` | Data source for Locator matching; `--diff` can be used to determine whether the UI is stable (see 10.1) |
| Screenshot | `android screen capture [--annotate]` | Collector captures screenshots; `--annotate` includes element annotation boxes |
| Coordinate fallback locating | `android screen resolve` | Convert labels on the annotated screenshot to screen coordinates, as a fallback when Locator fails (see 8.3) |
| Device management | `android emulator create/list/start/stop` | Emulator lifecycle management |

### 4.2 Not Provided by Android CLI, Must Be Implemented by APR Directly via ADB

Android CLI **does not** provide native commands for click / input / swipe / log collection. The following capabilities must be invoked by APR directly via `adb`:

- Click / LongClick / Swipe / Back → `adb shell input tap|swipe|keyevent`
- InputText → `adb shell input text`
- Logcat collection → `adb logcat`

Therefore the architecture diagram in section 8 needs to be corrected to:

```
Journey

↓

Interaction

↓ ↘

Android CLI      ADB (direct)

(layout / screenshot / run / device)   (click / input / swipe / logcat)
```

### 4.3 Build Stage

`android run` does not perform the build. The Runtime Flow must explicitly include an independent Build stage (Gradle). The corrected flow is shown in section 5.

---

## Android Project

The first phase only supports:

- Android Application
- Gradle Project

---

## Device

Supported:

- Emulator
- USB Device

By default only one device is connected at a time.

---

# 5. Runtime Flow

```
Build (Gradle)

↓

Run (android run, deploy the built APK)

↓

Replay Journey (with step-by-step assertion verification)

↓

Capture Screenshot

↓

Collect Logcat (sliced by step time window)

↓

Generate Report (layered judgment results)
```

The overall flow stays simple, but Build exists explicitly as an independent stage, no longer implied within Run.

---

# 6. Journey

Journey represents:

A complete user operation, **and the expected result after each step**.

For example:

```
Home

↓

Click search

↓ (expected: navigate to SearchActivity)

Input hello world

↓ (expected: log appears query=hello world)

Wait for page refresh
```

Journey does not care about:

- Activity internal implementation details
- Fragment
- Underlying ADB commands

It only describes user behavior + the verifiable result that the behavior should achieve.

---

# 7. Journey Format

The first phase uses JSON.

On top of the existing `action` / `locator`, an optional `expect` field is added to carry the assertions needed for precise verification.

```json
{
  "name": "Search",

  "steps": [

    {
      "action": "click",

      "locator": {
        "resourceId": "toolbar_search"
      },

      "expect": {
        "type": "activity",
        "value": "com.example.SearchActivity",
        "timeoutMs": 3000
      }
    },

    {
      "action": "inputText",

      "text": "hello world",

      "expect": {
        "type": "logcat",
        "tag": "SearchViewModel",
        "pattern": "query=hello world",
        "level": "D",
        "timeoutMs": 3000
      }
    }

  ]
}
```

## 7.1 `expect` Types

The first phase supports three assertion types:

| type | Description | Judgment basis |
|---|---|---|
| `activity` | Whether the current foreground Activity matches expectations | Obtain the current Activity via `dumpsys activity` or equivalent |
| `element` | Whether a specified element appears on the new page (a finer-grained "navigation succeeded" judgment) | `android layout` matching resourceId/text |
| `logcat` | Whether matching logs appear within the specified time window | See 11.1 time-window slicing rules |

`expect` is an optional field. A step without `expect` only performs "structural-level" validation (Locator found + Action executed successfully), not "assertion-level" validation. The two are reflected separately in the Report (see section 12).

Recorder auto-generates `action` and `locator`. `expect` in principle needs to be explicitly supplemented by the developer or AI after recording — this is an intentional design tradeoff: APR does not analyze business semantics, does not infer "where this step should navigate to," and only deterministically validates human-declared expectations, so that the credibility of the assertions themselves does not depend on AI judgment.

---

# 8. Interaction Layer

Journey does not directly execute ADB.

All operations go through the Interaction Layer uniformly.

```
Journey

↓

Interaction

↓ ↘

Android CLI (layout/screenshot/run)     ADB (click/input/swipe/logcat)
```

This avoids coupling Journey with the underlying implementation, and also encapsulates "which capabilities come from Android CLI and which from native ADB" inside the Interaction layer, transparent to the upper layer.

---

## Supported Actions

The first phase only supports:

| Action | Support | Execution |
|---------|---------|---|
| Click | ✅ | ADB |
| LongClick | ✅ | ADB |
| InputText | ✅ | ADB |
| Swipe | ✅ | ADB |
| Back | ✅ | ADB |
| Wait | ✅ | Internal scheduling, see 10.1 |

Other actions will be added later.

---

## Locator

Unified use of:

Android CLI Layout (`android layout`).

Locator priority:

1. resourceId
2. text
3. contentDescription

The first phase does not support:

- XPath
- Directly specifying a Coordinate

### 8.3 Fallback Locating (new)

When all three Locators above fail to locate the target element, the `screen capture --annotate` + `screen resolve` provided by Android CLI is allowed as a fallback: first capture a screenshot and get the annotation box, then convert the label to coordinates via `screen resolve` to perform the click.

This fallback path is only used as a degraded solution when locating fails, not as the preferred strategy, and when the fallback is triggered it must be clearly marked in the Report, indicating that the stability of this step is weaker than a regular Locator hit.

---

# 9. Recorder

Recorder is used to record a Journey.

Flow:

```
Start

↓

Developer Operates App

↓

Stop

↓

Generate Journey (action + locator)

↓

(optional) human/AI supplements expect assertions
```

The first phase Recorder auto-records:

- Action
- Locator

**It does not auto-generate `expect`**. Assertions involve business semantic judgment ("which page this step should navigate to" "what log should be printed"), which APR does not infer. They need to be explicitly supplemented to ensure the assertions themselves are trustworthy and non-speculative.

---

# 10. Replay

Replay executes operations according to the Journey, and verifies the corresponding `expect` (if any) after each step.

Each step:

```
Execute Action

↓

Wait Until Idle

↓

(if expect present) verify assertion, record result

↓

Next Action
```

Prohibited:

```
sleep(1000)
```

## 10.1 Concrete Implementation of Wait Until Idle

Based on `android layout --diff`:

1. After executing an Action, start polling `android layout --diff`
2. If N consecutive polls (recommended N=2~3) return an empty diff, the UI is judged stable and the next step can proceed
3. Set a timeout upper bound (recommended default 5s, overridable per Journey config). After timeout it is still considered "not stable," recorded as a failure for that step with the last diff content attached, for troubleshooting

This mechanism replaces the unresolved "unified wait" description in the original document, and also avoids hardcoded sleep.

## 10.2 Failure Handling Strategy (new)

On single-step failure (Locator miss / Action execution exception / Wait Until Idle timeout / assertion mismatch):

- Default strategy: terminate the current Journey, do not continue executing subsequent steps, to avoid stacking more uncontrollable operations on an erroneous state
- The Report clearly distinguishes failure types:
  - **Environment failure** (device not connected, App failed to start, etc.)
  - **Structural failure** (Locator miss, Action execution exception)
  - **Assertion failure** (navigation does not match expectations, log does not appear as expected)

The first phase does not perform automatic retries; retry strategy is left for later phases to evaluate.

---

# 11. Collector

After execution completes, uniformly collect:

- Screenshot
- Logcat

## 11.1 Logcat Time-Window Slicing (new)

To make log assertions trustworthy, Collector needs to slice logcat by step, rather than matching the entire log in a coarse way:

- Record timestamp `T0` before each Action starts
- Record timestamp `T1` when the corresponding Wait Until Idle ends (or assertion verification completes) for that Action
- The `expect.type = logcat` for that step only matches `pattern` within the `[T0, T1]` window

This avoids false judgments caused by unrelated logs produced by other components.

The first phase does not perform further semantic analysis on log content, only deterministic matching of tag + pattern.

---

# 12. Report

Output layered judgment results, rather than a single Success/Fail:

```
Run Success (whether the App started normally, did not crash)

Journey Structural Success (whether the Locator hit and Action executed successfully on each step)

Journey Assertion Success (whether each step's expect matched: navigation / element / log)

Screenshot

Logcat (sliced by step)

Duration

Fallback usage record (whether the 8.3 coordinate fallback locating was triggered)
```

The reason the three layers of judgment are displayed separately: when a problem occurs, the developer or AI needs to be able to immediately distinguish "the element was not found" "the navigation was wrong" or "the navigation was correct but the log was not printed," rather than seeing only a coarse failure.

The Report does not contain AI analysis; all judgments are based on deterministic rules.

---

# 13. Project Structure

```
apr/

├── cli/          # Android CLI wrapper (layout / screenshot / run / device)

├── adb/          # Native ADB wrapper (click / input / swipe / logcat)

├── runtime/      # Flow scheduling (Build → Run → Replay → Collect → Report)

├── interaction/  # User operations, uniformly orchestrates cli and adb

├── journey/      # Journey definition (including expect assertion schema)

├── recorder/     # Journey recording

├── collector/    # Logs and screenshots, including time-window slicing

└── report/       # Result output, layered judgment
```

Responsibilities:

**cli** — Android CLI wrapper, responsible for layout / screenshot / run / device management.

**adb** — Native ADB wrapper, responsible for click / input / swipe / logcat not covered by Android CLI.

**runtime** — Flow scheduling, including the explicit Build stage.

**interaction** — User operations, shielding the upper layer from the differences between cli and adb.

**journey** — Journey definition, including action / locator / expect.

**recorder** — Journey recording, only generates action + locator; expect needs to be supplemented separately.

**collector** — Logs and screenshots, slicing logcat by step time window.

**report** — Result output, with Run / Structural / Assertion three-layer judgment.

---

# 14. Success Criteria

After the first phase is complete, it should satisfy:

- Can record a Journey (action + locator)
- Can supplement assertions for Journey steps (navigation / log)
- Can repeatedly and deterministically execute a Journey
- Can automatically complete Build + Run
- Can stably determine page idle state based on Layout Diff, without hardcoded waits
- Can output Screenshot
- Can output Logcat sliced by step
- Can output layered (Run / Structural / Assertion) verification results
- Can stably complete development verification, and the verification result does not depend on AI judgment

Reaching the above goals allows entering the next phase.

Do not add complex capabilities in advance.
