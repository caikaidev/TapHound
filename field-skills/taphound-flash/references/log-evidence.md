# Project-derived logging evidence (not a fixed Tag convention)

This guide is for agents executing `tap-check` and `tap-fix`. Do not presume an app uses `android.util.Log`, class-name tags, a particular logger, a constant prefix, or JSON-formatted messages.

## Determine the app's real logging path

1. Starting at the changed use case or the crash trigger, trace **who calls whom**, including ViewModel/Presenter, service, repository/network/storage callbacks, and any other process. Identify the observable completion point (persisted write, server acknowledgement, state update) rather than only a button handler.
2. Search actual project source for relevant logging calls, aliases, extension functions, facades, interceptors, logging annotations, and wrapper implementation. Determine how the logger chooses its Tag, prefix, severity, routing, and whether messages are transformed. The Tag in `logcat` can differ from a class name and from source `TAG`.
3. Check build variants, min logging level, filtering, ProGuard/R8, developer toggles, async dispatch, subprocesses, and privacy suppression. A missing event may indicate the logger is disabled; this yields `INCONCLUSIVE`, not an automatic code regression.
4. Select **at least one downstream completion event** from the actual call chain. Prefer a request/correlation ID that ties trigger → background work → result. If IDs are generated at runtime, use a carefully scoped regex from source (do not invent a constant). Use `sourceRef` to record the code location behind the predicate.
5. Use narrow **operation windows**. `fromStep` is the zero-based index of the action whose beginning is the earliest acceptable evidence. `toStep` optionally limits evidence to a later step's completion; omit it for an asynchronous result observed after UI steps. `timeoutMs` controls the post-UI log observation budget (default 1500 ms, maximum 20000 ms).
6. Check independent observable UI state too. A log that says “success” is not proof the requested state persisted, especially for optimistic UI or async work. Correlate with the actual test data and a downstream result.

## Matching rules are project-derived

An optional top-level `logChecks` array contains predicates. Every check needs `id`, `fromStep` and **at least one of** `messageContains`, `messageRegex`, `tag`, `tagRegex`, `rawContains`, `rawRegex`; predicates within a check are combined with AND. All are case-sensitive. They are **matching expressions**, not global defaults for Tag/format. Never require a Tag when the actual app generates one dynamically or prepends a logger prefix. `rawContains`/`rawRegex` are for nonstandard output when the normal Android threadtime Tag/message split is insufficient.

```
{
  "version": 1,
  "verificationMode": "full",
  "packageName": "com.example.app",
  "steps": [
    { "action": "tap", "target": { "id": "submit" } },
    { "action": "expect", "target": { "text": "Saved" } }
  ],
  "logChecks": [
    {
      "id": "save-dispatched", "fromStep": 0,
      "messageContains": "replace with actual source-derived event and test correlation",
      "orderGroup": "save", "sourceRef": "path/to/logging/source:line"
    },
    {
      "id": "save-committed", "fromStep": 0,
      "messageRegex": "replace with actual escaped source-derived pattern",
      "orderGroup": "save", "sourceRef": "path/to/repository/source:line",
      "timeoutMs": 3000
    }
  ]
}
```

The snippets above are examples **only**: do not copy the messages or assume a `Saved` label exists. `orderGroup` compares matched lines in the declaration order, requiring strictly increasing order for a common group; only use this when the call chain guarantees that order. `minCount` defaults to 1. To assert that a known bad event must not occur, set `maxCount:0` (with omitted `minCount` or explicit 0). A negative-only plan cannot prove a full chain. Avoid expensive or overly broad regexes.

## Evidence collection

The Runner starts an auxiliary ADB logcat stream **before launching the app** even when Mobile MCP or Appium performs UI operations. It inserts a unique ADB Logcat marker and ignores everything before the marker. It collects Android `main`, `system`, and `crash` buffers and records host observation timestamps; matched logs are scoped to UI step starts and optional step ends. `logcat.txt` stays local and can contain sensitive user data; the JSON report contains match line numbers and hashes, not full log messages. A missing marker, stream failure, overflow or absent expected event must not result in `PASS`.

Android logcat timestamps and host receive times are not interchangeable. Host receive time may lag when an event backlog or heavy device contention exists; increase tolerances or use stronger correlation, never widen the match so much that unrelated events satisfy it. A `logcat` line does not by itself prove whether a process is still alive; combine with process/Crash checks when applicable.

The Runner cannot observe a logger that writes **only** to private files, an external telemetry server, or a backend inaccessible to `adb logcat`. If the necessary signal is absent, choose an independently observable integration test or propose targeted debug instrumentation. Return `INCONCLUSIVE` rather than fabricating log evidence; for an unreproduced bug, diagnostics are not a fix.

## Judging evidence

- `PASS`: required UI/product assertion(s) pass, and required *positive* downstream log stages are observed in their correct action windows (with correlation when necessary).
- `FAIL`: actual UI/functional assertion fails; or a prohibited log event is observed; or observed log events are in a demonstrably incorrect order.
- `INCONCLUSIVE`: an expected positive log is missing, the logging backend/level may be disabled, the stream is incomplete, or logs cannot identify the business path unambiguously.
- `BLOCKED`: a build, account, device, authorization or required Android logcat monitor cannot be set up. The Runner may report `INCONCLUSIVE` for a runtime logcat failure after backend selection; the Skill should describe it as an evidence blocker.

A test plan only proves its explicit observables. Source-derived log matches do not excuse weak UI predicates or a missing end-state check.
