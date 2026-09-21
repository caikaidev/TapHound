import { createHash } from "node:crypto";

import type { CheckpointDefinition } from "../../domain/checkpoint.js";
import type { CheckpointReport } from "../../domain/report.js";
import type { RuntimeSnapshotV1 } from "../../domain/runtime-snapshot.js";
import type { LoadedKnowledgeBundle } from "../../ports/knowledge-registry.js";
import type { AdbPort } from "../../ports/adb.js";
import type { UiSnapshotProvider } from "../../ports/ui-snapshot.js";
import type { UiSnapshot } from "../../ports/ui-snapshot.js";
import type { Clock } from "../../ports/clock.js";
import type { LogcatCollector } from "../collector/logcat-collector.js";
import { matchesLogcatEvent } from "../collector/logcat-event.js";
import { resolveLocatorIdentity } from "../locator/locator-resolver.js";
import { ScreenDetector } from "../recognition/screen-detector.js";

type Condition = CheckpointReport["conditions"][number];

export interface CheckpointEvaluation {
  report: CheckpointReport;
  matchedScreen?: string | undefined;
  snapshot?: UiSnapshot | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unresolvedConditions(
  checkpoint: CheckpointDefinition,
  message: string
): Condition[] {
  return [
    ...(checkpoint.expect.activity === undefined ? [] : [{
      kind: "activity" as const,
      status: "unresolved" as const,
      expected: checkpoint.expect.activity,
      message
    }]),
    ...(checkpoint.expect.screen === undefined ? [] : [{
      kind: "screen" as const,
      status: "unresolved" as const,
      expected: checkpoint.expect.screen,
      message
    }]),
    ...checkpoint.expect.visibleElements.map((locator): Condition => ({
      kind: "visibleElement",
      status: "unresolved",
      locator,
      message
    })),
    ...checkpoint.expect.absentElements.map((locator): Condition => ({
      kind: "absentElement",
      status: "unresolved",
      locator,
      message
    }))
  ];
}

function checkpointResult(
  checkpoint: CheckpointDefinition,
  conditions: Condition[],
  matchedScreen?: string
): CheckpointEvaluation {
  const status = conditions.some((condition) => condition.status === "failed")
    ? "failed"
    : conditions.some((condition) => condition.status === "unresolved")
      ? "unresolved"
      : "passed";
  return {
    report: {
      id: checkpoint.id,
      ...(checkpoint.stepIndex === undefined ? {} : { stepIndex: checkpoint.stepIndex }),
      status,
      conditions
    },
    ...(matchedScreen === undefined ? {} : { matchedScreen })
  };
}

export class CheckpointEvaluator {
  private readonly detector = new ScreenDetector();

  public readonly evaluate = async (input: {
    checkpoint: CheckpointDefinition;
    provider: UiSnapshotProvider;
    adb: AdbPort;
    packageName: string;
    deviceSerial: string;
    timeoutMs: number;
    knowledge?: LoadedKnowledgeBundle | undefined;
    knowledgeError?: string | undefined;
    signal?: AbortSignal | undefined;
    clock?: Clock | undefined;
    logcat?: LogcatCollector | undefined;
    stepStartedAt?: number | undefined;
    runStartedAt?: number | undefined;
    markers?: ReadonlyMap<string, number> | undefined;
    logcatEvidenceRef?: string | undefined;
    writeSnapshot?: ((path: string, snapshot: UiSnapshot) => Promise<void>) | undefined;
    exposeSnapshot?: boolean | undefined;
  }): Promise<CheckpointEvaluation> => {
    const { checkpoint } = input;
    if (checkpoint.expect.allOf !== undefined) {
      return this.evaluateAllOf(input);
    }
    let snapshot;
    try {
      snapshot = await input.provider.capture({
        reason: "evidence",
        freshness: "forceFresh",
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
    } catch (error) {
      return checkpointResult(
        checkpoint,
        unresolvedConditions(checkpoint, `Checkpoint layout unavailable: ${errorMessage(error)}`)
      );
    }

    let foreground;
    try {
      foreground = await input.adb.foregroundComponent({
        packageName: input.packageName,
        deviceSerial: input.deviceSerial,
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
    } catch (error) {
      return checkpointResult(
        checkpoint,
        unresolvedConditions(checkpoint, `Checkpoint foreground unavailable: ${errorMessage(error)}`)
      );
    }
    if (foreground.packageName !== input.packageName) {
      return checkpointResult(
        checkpoint,
        unresolvedConditions(
          checkpoint,
          `Checkpoint foreground package ${foreground.packageName} is not ${input.packageName}`
        )
      );
    }
    const activity = foreground.activity;
    const conditions: Condition[] = [];
    if (checkpoint.expect.activity !== undefined) {
      const expected = checkpoint.expect.activity;
      conditions.push({
        kind: "activity",
        status: activity === expected ? "passed" : "failed",
        expected,
        actual: activity
      });
    }
    let matchedScreen: string | undefined;
    if (checkpoint.expect.screen !== undefined) {
      const expected = checkpoint.expect.screen;
      if (
        input.knowledge === undefined
        || input.knowledge.index.packageName !== input.packageName
      ) {
        conditions.push({
          kind: "screen",
          status: "unresolved",
          expected,
          message: input.knowledgeError ?? (
            input.knowledge === undefined
              ? "Project Knowledge is unavailable"
              : "Project Knowledge belongs to another package"
          )
        });
      } else if (!input.knowledge.screens.some((screen) => screen.id === expected)) {
        conditions.push({
          kind: "screen",
          status: "unresolved",
          expected,
          message: `Screen ${expected} is not defined in Project Knowledge`
        });
      } else {
        const runtimeSnapshot: RuntimeSnapshotV1 = {
          version: 1,
          generationId: "checkpoint",
          baseRevision: 1,
          deviceSerial: input.deviceSerial,
          expectedPackageName: input.packageName,
          foregroundPackageName: input.packageName,
          activity,
          pid: null,
          capturedAt: snapshot.capturedAt,
          layout: [...snapshot.roots]
        };
        try {
          const detection = this.detector.detect({
            snapshot: runtimeSnapshot,
            anchors: input.knowledge.anchors,
            screens: input.knowledge.screens
          });
          if (detection.status === "matched") {
            matchedScreen = detection.screenId;
            conditions.push({
              kind: "screen",
              status: matchedScreen === expected ? "passed" : "failed",
              expected,
              actual: matchedScreen
            });
          } else {
            conditions.push({
              kind: "screen",
              status: "unresolved",
              expected,
              message: detection.status === "ambiguous"
                ? `Screen detection is ambiguous: ${detection.screenIds.join(", ")}`
                : "Screen detection could not identify a screen"
            });
          }
        } catch (error) {
          conditions.push({
            kind: "screen",
            status: "unresolved",
            expected,
            message: `Screen detection failed: ${errorMessage(error)}`
          });
        }
      }
    }
    for (const [kind, locators] of [
      ["visibleElement", checkpoint.expect.visibleElements],
      ["absentElement", checkpoint.expect.absentElements]
    ] as const) {
      for (const locator of locators) {
        const resolution = resolveLocatorIdentity(snapshot.roots, locator);
        if (resolution.status === "found") {
          conditions.push({
            kind,
            locator,
            status: kind === "visibleElement" ? "passed" : "failed"
          });
        } else if (
          resolution.code === "LOCATOR_AMBIGUOUS"
          || resolution.evidenceMismatch === true
          || (resolution.code !== "LOCATOR_NOT_FOUND")
        ) {
          conditions.push({
            kind,
            locator,
            status: "unresolved",
            message: resolution.message
          });
        } else {
          conditions.push({
            kind,
            locator,
            status: kind === "absentElement" ? "passed" : "failed",
            ...(kind === "visibleElement" ? { message: resolution.message } : {})
          });
        }
      }
    }
    return {
      ...checkpointResult(checkpoint, conditions, matchedScreen),
      ...(input.exposeSnapshot === true ? { snapshot } : {})
    };
  };

  private readonly evaluateAllOf = async (
    input: Parameters<CheckpointEvaluator["evaluate"]>[0]
  ): Promise<CheckpointEvaluation> => {
    const { checkpoint, clock, logcat } = input;
    const allOf = checkpoint.expect.allOf ?? [];
    const startedAtMs = clock?.now() ?? 0;
    const timeoutMs = checkpoint.expect.timeoutMs ?? 0;
    const deadline = startedAtMs + timeoutMs;
    const uiConditions = allOf.filter((condition) => condition.kind !== "logcatEvent");
    const activityCondition = uiConditions.find((condition) => condition.kind === "activity");
    const screenCondition = uiConditions.find((condition) => condition.kind === "screen");
    const uiExpect = {
      ...(activityCondition?.kind === "activity" ? { activity: activityCondition.expected } : {}),
      ...(screenCondition?.kind === "screen" ? { screen: screenCondition.expected } : {}),
      visibleElements: uiConditions.flatMap((condition) => (
        condition.kind === "visibleElement" ? [condition.locator] : []
      )),
      absentElements: uiConditions.flatMap((condition) => (
        condition.kind === "absentElement" ? [condition.locator] : []
      ))
    };
    const observed = new Map<number, Condition>();
    let matchedScreen: string | undefined;
    const identity = (condition: Condition): string => JSON.stringify([
      condition.kind,
      condition.kind === "activity" || condition.kind === "screen"
        ? condition.expected
        : condition.kind === "logcatEvent" ? condition.expect : condition.locator
    ]);
    const buildReport = (): CheckpointEvaluation => {
      const conditions = allOf.map((condition, index): Condition => (
        observed.get(index) ?? (
          condition.kind === "logcatEvent"
            ? {
                kind: "logcatEvent",
                expect: condition.expect,
                status: "failed",
                matchedCount: 0,
                startedAtMs,
                message: "Logcat event did not appear before the shared timeout"
              }
            : {
                ...condition,
                status: "failed",
                startedAtMs,
                message: "Condition did not match before the shared timeout"
              }
        )
      ));
      return checkpointResult(checkpoint, conditions, matchedScreen);
    };
    const unresolved = (message: string): CheckpointEvaluation => checkpointResult(
      checkpoint,
      allOf.map((condition): Condition => condition.kind === "logcatEvent"
        ? {
            kind: "logcatEvent", expect: condition.expect,
            status: "unresolved", matchedCount: 0, startedAtMs, message
          }
        : { ...condition, status: "unresolved", startedAtMs, message })
    );
    if (clock === undefined || timeoutMs <= 0) {
      const conditions: Condition[] = allOf.map((condition): Condition => (
        condition.kind === "logcatEvent"
          ? {
              kind: "logcatEvent", expect: condition.expect,
              status: "unresolved", matchedCount: 0, startedAtMs,
              message: "Checkpoint event clock is unavailable"
            }
          : { ...condition, status: "unresolved", startedAtMs,
              message: "Checkpoint observation clock is unavailable" }
      ));
      return checkpointResult(checkpoint, conditions);
    }
    // Even a Logcat-only Checkpoint requires one fresh layout and a valid
    // foreground package before it can assert application evidence.
    if (uiConditions.length === 0) {
      try {
        await input.provider.capture({
          reason: "evidence",
          freshness: "forceFresh",
          timeoutMs: Math.min(input.timeoutMs, timeoutMs),
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        const foreground = await input.adb.foregroundComponent({
          packageName: input.packageName,
          deviceSerial: input.deviceSerial,
          timeoutMs: Math.max(1, Math.min(input.timeoutMs, deadline - clock.now())),
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        if (foreground.packageName !== input.packageName) {
          return unresolved(`Checkpoint target app is not foreground: ${foreground.packageName}`);
        }
      } catch (error) {
        return unresolved(`Checkpoint UI or foreground unavailable: ${errorMessage(error)}`);
      }
    }
    for (;;) {
      if (input.signal?.aborted === true) {
        return unresolved("Checkpoint was cancelled");
      }
      const now = clock.now();
      const remaining = Math.max(1, deadline - now);
      if (uiConditions.length === 0) {
        try {
          const foreground = await input.adb.foregroundComponent({
            packageName: input.packageName,
            deviceSerial: input.deviceSerial,
            timeoutMs: Math.min(input.timeoutMs, remaining),
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          if (foreground.packageName !== input.packageName) {
            return unresolved(`Checkpoint target app is not foreground: ${foreground.packageName}`);
          }
        } catch (error) {
          return unresolved(`Checkpoint foreground unavailable: ${errorMessage(error)}`);
        }
      }
      if (uiConditions.some((condition) =>
        observed.get(allOf.indexOf(condition))?.status !== "passed"
      )) {
        const ui = await this.evaluate({
          ...input,
          checkpoint: {
            ...checkpoint,
            expect: uiExpect
          },
          timeoutMs: Math.min(input.timeoutMs, remaining),
          exposeSnapshot: true
        });
        const uiObservedAtMs = clock.now();
        if (ui.matchedScreen !== undefined) {
          matchedScreen = ui.matchedScreen;
        }
        for (const [index, condition] of allOf.entries()) {
          if (condition.kind === "logcatEvent"
            || observed.get(index)?.status === "passed") {
            continue;
          }
          const matching = ui.report.conditions.find((entry) => (
            identity(entry) === identity({
              ...condition,
              status: "passed"
            })
          ));
          if (matching === undefined) {
            return unresolved("Checkpoint UI observation did not cover every condition");
          }
          if (matching.status === "unresolved") {
            return unresolved(matching.message ?? "Checkpoint UI evidence is unresolved");
          }
          if (uiObservedAtMs > deadline && matching.status === "passed") {
            observed.set(index, {
              ...matching,
              status: "failed",
              startedAtMs,
              message: "UI condition matched after the shared timeout"
            });
            continue;
          }
          let evidenceRef: string | undefined;
          if (input.writeSnapshot !== undefined && ui.snapshot !== undefined
            && (matching.status === "passed" || clock.now() >= deadline)) {
            evidenceRef = `checkpoints/${checkpoint.id}-${String(index)}-ui.json`;
            try {
              await input.writeSnapshot(evidenceRef, ui.snapshot);
            } catch (error) {
              return unresolved(`Checkpoint UI artifact unavailable: ${errorMessage(error)}`);
            }
          }
          observed.set(index, {
            ...matching,
            startedAtMs,
            ...(matching.status === "passed" ? { matchedAtMs: uiObservedAtMs } : {}),
            ...(evidenceRef === undefined ? {} : { evidenceRef })
          });
        }
      }
      for (const [index, condition] of allOf.entries()) {
        if (condition.kind !== "logcatEvent") {
          continue;
        }
        const window = condition.expect.window;
        const windowStart = window.from === "stepStart"
          ? input.stepStartedAt
          : window.from === "runStart" ? input.runStartedAt
            : input.markers?.get(window.markerId);
        if (windowStart === undefined || logcat === undefined
          || !logcat.completeSince(windowStart)) {
          observed.set(index, {
            kind: "logcatEvent", expect: condition.expect, status: "unresolved",
            matchedCount: 0, startedAtMs,
            message: "Checkpoint Logcat window is unavailable or incomplete"
          });
          continue;
        }
        const matches = logcat.linesBetween(windowStart, Math.min(clock.now(), deadline))
          .filter((line) => matchesLogcatEvent(line, {
            ...condition.expect,
            timeoutMs
          }));
        const first = matches[0];
        observed.set(index, {
          kind: "logcatEvent",
          expect: condition.expect,
          status: matches.length > 1 ? "failed"
            : matches.length === 1 ? "passed" : "failed",
          matchedCount: matches.length,
          startedAtMs: windowStart,
          ...(first === undefined || matches.length !== 1 ? {} : {
            matchedLineSha256: createHash("sha256")
              .update(first.raw).digest("hex"),
            matchedAtMs: first.receivedAt
          }),
          ...(input.logcatEvidenceRef === undefined ? {} : {
            evidenceRef: input.logcatEvidenceRef
          }),
          ...(matches.length > 1 ? { message: "Logcat event is not unique" } : {})
        });
      }
      if ([...observed.values()].some((condition) => (
        condition.status === "unresolved"
        || (condition.kind === "logcatEvent" && condition.matchedCount > 1)
      ))) {
        return buildReport();
      }
      const allPassed = observed.size === allOf.length
        && [...observed.values()].every((condition) => condition.status === "passed");
      if (allPassed && !allOf.some((condition) => condition.kind === "logcatEvent")) {
        return buildReport();
      }
      if (clock.now() >= deadline) {
        return buildReport();
      }
      try {
        await clock.sleep(Math.min(100, deadline - clock.now()), input.signal);
      } catch (error) {
        return unresolved(`Checkpoint polling was interrupted: ${errorMessage(error)}`);
      }
    }
  };
}
