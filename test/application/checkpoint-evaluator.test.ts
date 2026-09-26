import { describe, expect, it, vi } from "vitest";

import { CheckpointEvaluator } from "../../src/application/checkpoint/checkpoint-evaluator.js";
import { CheckpointDefinitionSchema } from "../../src/domain/checkpoint.js";
import type { LayoutElement } from "../../src/domain/layout.js";
import { LogcatCollector } from "../../src/application/collector/logcat-collector.js";
import { runtimeFixture } from "../fakes/runtime-fixture.js";
import { FakeClock } from "../fakes/fake-clock.js";
import { uiSnapshotProvider } from "../fakes/ui-snapshot.js";

function evaluate(
  roots: readonly LayoutElement[],
  checkpoint: ReturnType<typeof CheckpointDefinitionSchema.parse>
): ReturnType<CheckpointEvaluator["evaluate"]> {
  return new CheckpointEvaluator().evaluate({
    checkpoint,
    provider: uiSnapshotProvider(roots),
    adb: runtimeFixture().adb,
    packageName: "com.example.app",
    deviceSerial: "emulator-5554",
    timeoutMs: 500,
    clock: new FakeClock()
  });
}

describe("CheckpointEvaluator", () => {
  const event = {
    kind: "logcatEvent" as const,
    expect: {
      type: "logcatEvent" as const,
      tag: "Search",
      event: "results",
      unique: true as const,
      fields: { query: "hello" },
      window: { from: "marker" as const, markerId: "search-start" }
    }
  };
  async function eventFixture(limits?: { maxLines: number; maxBytes: number }): Promise<{
    fixture: ReturnType<typeof runtimeFixture>;
    logcat: LogcatCollector;
    clock: FakeClock;
    emit: () => void;
  }> {
    const fixture = runtimeFixture();
    const clock = new FakeClock();
    clock.currentTime = 10;
    const logcat = new LogcatCollector(fixture.adb, clock, limits);
    await logcat.start({ deviceSerial: "emulator-5554" });
    logcat.scopeToPids([42]);
    const options = vi.mocked(fixture.adb.startLogcat).mock.calls[0]?.[0];
    if (options === undefined) throw new Error("Logcat did not start");
    return {
      fixture,
      logcat,
      clock,
      emit: (): void => {
        options.onStdoutLine(
          '09-15 15:00:00.123  42  43 D Search: {"event":"results","fields":{"query":"hello"}}'
        );
      }
    };
  }

  it("evaluates marker-window UI and event conditions within one shared budget", async () => {
    const { fixture, logcat, clock, emit } = await eventFixture();
    emit();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "search-ready", name: "Search ready",
      expect: {
        timeoutMs: 200, allOf: [
          { kind: "visibleElement", locator: { resourceId: "search" } },
          event
        ]
      }
    });
    const provider = uiSnapshotProvider([{
      id: "search", resourceId: "search", enabled: true, children: []
    }]);
    const writeSnapshot = vi.fn(() => Promise.resolve());
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider, adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, markers: new Map([["search-start", 5]]),
      writeSnapshot, logcatEvidenceRef: "logcat-default.txt"
    });
    expect(result.report).toMatchObject({
      status: "passed",
      conditions: [
        { kind: "visibleElement", status: "passed", startedAtMs: 10,
          evidenceRef: "checkpoints/search-ready-0-ui.json" },
        { kind: "logcatEvent", status: "passed", startedAtMs: 5,
          matchedCount: 1, evidenceRef: "logcat-default.txt" }
      ]
    });
    expect(result.report.conditions[1]).toHaveProperty("matchedLineSha256");
    expect(clock.currentTime).toBe(210);
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    expect(provider.capture).toHaveBeenCalledWith(expect.objectContaining({
      freshness: "forceFresh"
    }));
  });

  it("reports partial UI success and an unmatched event at the shared deadline", async () => {
    const { fixture, logcat, clock } = await eventFixture();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "search-missing", name: "Search missing",
      expect: { timeoutMs: 150, allOf: [
        { kind: "absentElement", locator: { resourceId: "spinner" } }, event
      ] }
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider: uiSnapshotProvider([]), adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, markers: new Map([["search-start", 5]])
    });
    expect(result.report).toMatchObject({ status: "failed", conditions: [
      { kind: "absentElement", status: "passed" },
      { kind: "logcatEvent", status: "failed", matchedCount: 0 }
    ] });
    expect(clock.currentTime).toBe(160);
  });

  it("does not count UI observations that finish beyond the shared deadline", async () => {
    const { fixture, clock } = await eventFixture();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "slow-ui", name: "Slow UI",
      expect: { timeoutMs: 200, allOf: [{
        kind: "visibleElement", locator: { resourceId: "search" }
      }] }
    });
    const provider = uiSnapshotProvider([{
      id: "search", resourceId: "search", enabled: true, children: []
    }]);
    const capture = vi.mocked(provider.capture).getMockImplementation();
    if (capture === undefined) throw new Error("Missing UI capture fixture");
    vi.mocked(provider.capture).mockImplementation((options) => {
      clock.currentTime = 211;
      return capture(options);
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider, adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock
    });
    expect(result.report).toMatchObject({
      status: "failed", conditions: [{
        kind: "visibleElement", status: "failed",
        message: "UI condition matched after the shared timeout"
      }]
    });
  });

  it("does not count events received after the shared deadline", async () => {
    const { fixture, logcat, clock, emit } = await eventFixture();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "late-event", name: "Late event",
      expect: { timeoutMs: 200, allOf: [event] }
    });
    const provider = uiSnapshotProvider([]);
    const capture = vi.mocked(provider.capture).getMockImplementation();
    if (capture === undefined) throw new Error("Missing UI capture fixture");
    vi.mocked(provider.capture).mockImplementation((options) => {
      clock.currentTime = 211;
      emit();
      return capture(options);
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider, adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, markers: new Map([["search-start", 5]])
    });
    expect(result.report).toMatchObject({
      status: "failed", conditions: [{
        kind: "logcatEvent", status: "failed", matchedCount: 0
      }]
    });
  });

  it("fails closed on duplicate events or an unavailable marker window", async () => {
    const { fixture, logcat, clock, emit } = await eventFixture();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "search-event", name: "Search event",
      expect: { timeoutMs: 200, allOf: [event] }
    });
    emit();
    emit();
    const options = {
      checkpoint, provider: uiSnapshotProvider([]), adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, logcatEvidenceRef: "logcat-default.txt"
    };
    const duplicate = await new CheckpointEvaluator().evaluate({
      ...options, markers: new Map([["search-start", 5]])
    });
    expect(duplicate.report).toMatchObject({
      status: "failed", conditions: [{
        kind: "logcatEvent", status: "failed", matchedCount: 2,
        message: "Logcat event is not unique"
      }]
    });
    expect(clock.currentTime).toBe(10);
    const missing = await new CheckpointEvaluator().evaluate({
      ...options, markers: new Map()
    });
    expect(missing.report).toMatchObject({
      status: "unresolved", conditions: [{ kind: "logcatEvent", status: "unresolved" }]
    });
  });

  it("does not pass a Logcat window after its matching lines were dropped", async () => {
    const { fixture, logcat, clock, emit } = await eventFixture({
      maxLines: 1, maxBytes: 1000
    });
    emit();
    emit();
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "search-overflow", name: "Search overflow",
      expect: { timeoutMs: 200, allOf: [event] }
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider: uiSnapshotProvider([]), adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, markers: new Map([["search-start", 5]])
    });
    expect(result.report).toMatchObject({
      status: "unresolved", conditions: [{
        kind: "logcatEvent", status: "unresolved", matchedCount: 0
      }]
    });
    expect(logcat.metadata().droppedLines).toBeGreaterThan(0);
  });

  it("rejects event-only evidence when foreground is not the target app", async () => {
    const { fixture, logcat, clock, emit } = await eventFixture();
    emit();
    vi.mocked(fixture.adb.foregroundComponent).mockResolvedValue({
      packageName: "com.example.other", activity: "com.example.other.MainActivity"
    });
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1, id: "search-event", name: "Search event",
      expect: { timeoutMs: 200, allOf: [event] }
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint, provider: uiSnapshotProvider([]), adb: fixture.adb,
      packageName: "com.example.app", deviceSerial: "emulator-5554",
      timeoutMs: 500, clock, logcat, markers: new Map([["search-start", 5]])
    });
    expect(result.report.status).toBe("unresolved");
    expect(result.report.conditions).toMatchObject([
      { kind: "logcatEvent", status: "unresolved", matchedCount: 0 }
    ]);
  });

  it("does not mistake ambiguous or evidence-mismatched Locators for absence", async () => {
    const element: LayoutElement = {
      id: "search",
      resourceId: "search",
      enabled: true,
      children: []
    };
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1,
      id: "search-absent",
      name: "Search absent",
      expect: {
        allOf: [
          { kind: "absentElement", locator: { resourceId: "search" } }
        ],
        timeoutMs: 100
      }
    });
    const result = await evaluate([element, { ...element, id: "another" }], checkpoint);
    expect(result.report).toMatchObject({
      status: "unresolved",
      conditions: [{
        kind: "absentElement",
        status: "unresolved",
        message: expect.stringContaining("matches 2") as unknown
      }]
    });
  });

  it("marks every condition unresolved when a fresh snapshot fails", async () => {
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1,
      id: "ready",
      name: "Ready",
      expect: {
        allOf: [
          { kind: "activity", expected: "com.example.app.SearchActivity" },
          { kind: "visibleElement", locator: { resourceId: "search" } },
          { kind: "absentElement", locator: { resourceId: "spinner" } }
        ],
        timeoutMs: 100
      }
    });
    const provider = uiSnapshotProvider();
    vi.mocked(provider.capture).mockRejectedValue(new Error("hierarchy unavailable"));
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint,
      provider,
      adb: runtimeFixture().adb,
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      timeoutMs: 500,
      clock: new FakeClock()
    });
    expect(provider.capture).toHaveBeenCalledWith({
      reason: "evidence",
      freshness: "forceFresh",
      timeoutMs: 100
    });
    expect(result.report.status).toBe("unresolved");
    expect(result.report.conditions.map((condition) => condition.status))
      .toEqual(["unresolved", "unresolved", "unresolved"]);
  });

  it("does not assert absence against another foreground package", async () => {
    const checkpoint = CheckpointDefinitionSchema.parse({
      version: 1,
      id: "spinner-gone",
      name: "Spinner gone",
      expect: {
        allOf: [
          { kind: "absentElement", locator: { resourceId: "spinner" } }
        ],
        timeoutMs: 100
      }
    });
    const fixture = runtimeFixture();
    vi.mocked(fixture.adb.foregroundComponent).mockResolvedValue({
      packageName: "com.example.other",
      activity: "com.example.other.MainActivity"
    });
    const result = await new CheckpointEvaluator().evaluate({
      checkpoint,
      provider: uiSnapshotProvider([]),
      adb: fixture.adb,
      packageName: "com.example.app",
      deviceSerial: "emulator-5554",
      timeoutMs: 500,
      clock: new FakeClock()
    });
    expect(result.report).toMatchObject({
      status: "unresolved",
      conditions: [{
        kind: "absentElement",
        status: "unresolved",
        message: expect.stringContaining("com.example.other") as unknown
      }]
    });
  });
});
