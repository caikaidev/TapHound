import { createHmac } from "node:crypto";
import { join, resolve } from "node:path";

import { TapHoundConfigSchema, type TapHoundConfig } from "../../domain/config.js";
import {
  CommandEventSchema,
  DiagnosticsBundleSchema,
  type CommandEvent,
  type DiagnosticsBundle,
  type RunSummary,
  type StepSummary
} from "../../domain/diagnostics.js";
import type { Locator } from "../../domain/layout.js";
import { TapHoundReportSchema, type TapHoundReport } from "../../domain/report.js";
import { CONFIG_PATH, DEFAULT_ARTIFACTS_DIR } from "../../domain/workspace.js";
import type { DiagnosticsJournal } from "../../ports/diagnostics.js";

export interface DiagnosticsExporterDependencies {
  journal: DiagnosticsJournal;
  readJson: (path: string) => Promise<unknown>;
  now: () => Date;
  taphoundVersion: string;
  host: DiagnosticsBundle["host"];
}

export interface DiagnosticsExportInput {
  projectRoot: string;
  /** Most recent journal events to include. */
  eventLimit: number;
  /** Most recent referenced runs to summarize. */
  runLimit: number;
}

const TOKEN = /^[a-zA-Z][a-zA-Z\d]{0,31}$/;
const VERSION = /^[\w.+-]{1,64}$/;
const TOOL_NAMES = ["node", "adb", "android"] as const;
const LOCATOR_FIELDS = ["resourceId", "text", "contentDescription", "index", "within"] as const;

/** Stable ordinal names for identifying strings, shared across one bundle. */
class Aliases {
  private readonly values = new Map<string, string>();

  public constructor(private readonly prefix: string) {}

  public of(value: string): string {
    let alias = this.values.get(value);
    if (alias === undefined) {
      alias = `${this.prefix}#${String(this.values.size + 1)}`;
      this.values.set(value, alias);
    }
    return alias;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function parseEvents(lines: readonly string[]): { events: CommandEvent[]; skipped: number } {
  const events: CommandEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      const parsed = CommandEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        events.push(parsed.data);
        continue;
      }
    } catch {
      // A torn or foreign line is counted, never exported.
    }
    skipped += 1;
  }
  return { events, skipped };
}

function configSummary(config: TapHoundConfig): NonNullable<DiagnosticsBundle["config"]> {
  return {
    idle: {
      strategy: config.idle.strategy,
      pollIntervalMs: config.idle.pollIntervalMs,
      stablePolls: config.idle.stablePolls,
      timeoutMs: config.idle.timeoutMs,
      ...(config.idle.ignoreCursorBlink === undefined
        ? {}
        : { ignoreCursorBlink: config.idle.ignoreCursorBlink }),
      ...(config.idle.ignoreLayoutDrift === undefined
        ? {}
        : { ignoreLayoutDrift: config.idle.ignoreLayoutDrift }),
      deviceProfiles: config.idle.deviceProfiles?.length ?? 0
    },
    ...(config.ui === undefined
      ? {}
      : {
          ui: {
            backend: config.ui.backend,
            ...(config.ui.snapshotTimeoutMs === undefined
              ? {}
              : { snapshotTimeoutMs: config.ui.snapshotTimeoutMs }),
            ...(config.ui.cacheEnabled === undefined
              ? {}
              : { cacheEnabled: config.ui.cacheEnabled })
          }
        }),
    ...(config.runtime === undefined ? {} : { runtime: { backend: config.runtime.backend } })
  };
}

/**
 * Builds a feedback bundle from the local journal and the reports it
 * references. Only allowlisted structural facts survive: identifying strings
 * become ordinal aliases or salted digests, and everything else is dropped.
 * The result is validated against the strict bundle schema before return.
 */
export class DiagnosticsExporter {
  public constructor(private readonly dependencies: DiagnosticsExporterDependencies) {}

  public async export(input: DiagnosticsExportInput): Promise<DiagnosticsBundle> {
    const { events: allEvents, skipped } = parseEvents(
      await this.dependencies.journal.readLines(input.projectRoot)
    );
    const events = allEvents.slice(-Math.max(0, input.eventLimit));
    const config = await this.readConfig(input.projectRoot);
    const salt = await this.dependencies.journal.salt(input.projectRoot);
    const runs = new Aliases("run");
    const activities = new Aliases("activity");
    const journeys = new Aliases("journey");
    const devices = new Aliases("device");
    const locatorId = (locator: Locator): string => createHmac("sha256", salt)
      .update(JSON.stringify(canonical(locator)))
      .digest("hex")
      .slice(0, 16);

    const runIds = [...new Set(events.flatMap((event) => (
      event.runId === undefined ? [] : [event.runId]
    )))];
    // Aliases follow journal order, whichever runs end up summarized.
    for (const runId of runIds) runs.of(runId);
    const artifactsDir = resolve(input.projectRoot, config?.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
    const summaries: RunSummary[] = [];
    for (const runId of runIds.slice(-Math.max(0, input.runLimit))) {
      const report = await this.readReport(join(artifactsDir, runId, "report.json"));
      if (report === undefined) continue;
      summaries.push(summarizeRun(report, runs.of(runId), {
        activity: (value) => activities.of(value),
        journey: (value) => journeys.of(value),
        device: (value) => devices.of(value),
        locatorId
      }));
    }

    return DiagnosticsBundleSchema.parse({
      version: 1,
      generatedAt: this.dependencies.now().toISOString(),
      taphoundVersion: this.dependencies.taphoundVersion,
      host: this.dependencies.host,
      ...(config === undefined ? {} : { config: configSummary(config) }),
      journal: {
        events: events.map((event) => ({
          ...event,
          ...(event.runId === undefined ? {} : { runId: runs.of(event.runId) })
        })),
        skippedLines: skipped
      },
      runs: summaries
    });
  }

  private async readConfig(projectRoot: string): Promise<TapHoundConfig | undefined> {
    try {
      const parsed = TapHoundConfigSchema.safeParse(
        await this.dependencies.readJson(join(projectRoot, CONFIG_PATH))
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async readReport(path: string): Promise<TapHoundReport | undefined> {
    try {
      const parsed = TapHoundReportSchema.safeParse(await this.dependencies.readJson(path));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

interface Redactors {
  activity: (value: string) => string;
  journey: (value: string) => string;
  device: (value: string) => string;
  locatorId: (locator: Locator) => string;
}

type ReportStep = TapHoundReport["steps"][number];

function summarizeStep(step: ReportStep, redact: Redactors): StepSummary {
  const locator = step.locator;
  const requested = locator?.requested;
  return {
    index: step.index,
    action: step.action,
    status: step.status,
    ...(step.device === undefined ? {} : { device: redact.device(step.device) }),
    durationMs: step.durationMs,
    ...(locator === undefined
      ? {}
      : {
          locator: {
            status: locator.status,
            ...(locator.matchedBy === undefined ? {} : { matchedBy: locator.matchedBy }),
            requestedFields: requested === undefined
              ? []
              : LOCATOR_FIELDS.filter((field) => requested[field] !== undefined),
            ...(requested === undefined ? {} : { locatorId: redact.locatorId(requested) }),
            ...(locator.anchor === undefined ? {} : { anchorStatus: locator.anchor.status }),
            fallbackUsed: locator.fallbackUsed
          }
        }),
    ...(step.idle === undefined
      ? {}
      : {
          idle: {
            status: step.idle.status,
            polls: step.idle.polls,
            ...(step.idle.durationMs === undefined ? {} : { durationMs: step.idle.durationMs }),
            ...(step.idle.samplingDurationMs === undefined
              ? {}
              : { samplingDurationMs: step.idle.samplingDurationMs }),
            ...(step.idle.strategy === undefined ? {} : { strategy: step.idle.strategy }),
            ...(step.idle.backend === undefined ? {} : { backend: step.idle.backend }),
            ...(step.idle.fallbackUsed === undefined
              ? {}
              : { fallbackUsed: step.idle.fallbackUsed }),
            ...(step.idle.frameActivityDetected === undefined
              ? {}
              : { frameActivityDetected: step.idle.frameActivityDetected }),
            ...(step.idle.lastDiff === undefined
              ? {}
              : { lastDiffCount: step.idle.lastDiff.length })
          }
        }),
    ...(step.activity === undefined
      ? {}
      : {
          activity: {
            before: activityCheck(step.activity.before, redact),
            after: activityCheck(step.activity.after, redact)
          }
        }),
    ...(step.expectation === undefined
      ? {}
      : {
          expectation: {
            type: step.expectation.type,
            status: step.expectation.status,
            ...(step.expectation.code === undefined ? {} : { code: step.expectation.code })
          }
        }),
    ...(step.scroll === undefined ? {} : { scroll: { ...step.scroll } })
  };
}

function activityCheck(
  check: NonNullable<ReportStep["activity"]>["before"],
  redact: Redactors
): NonNullable<StepSummary["activity"]>["before"] {
  return {
    status: check.status,
    expected: redact.activity(check.expected),
    ...(check.actual === undefined ? {} : { actual: redact.activity(check.actual) })
  };
}

function summarizeRun(report: TapHoundReport, run: string, redact: Redactors): RunSummary {
  const failure = report.primaryFailure;
  return {
    run,
    status: report.status,
    durationMs: report.durationMs,
    journey: redact.journey(report.journey.name),
    devices: report.environment.devices.map((device) => ({
      device: redact.device(device.role),
      ...(device.uiBackend === undefined
        ? {}
        : {
            uiBackend: {
              id: device.uiBackend.id,
              adapterVersion: VERSION.test(device.uiBackend.adapterVersion)
                ? device.uiBackend.adapterVersion
                : "unknown",
              ...(device.uiBackend.engineVersion !== undefined
                && VERSION.test(device.uiBackend.engineVersion)
                ? { engineVersion: device.uiBackend.engineVersion }
                : {})
            }
          }),
      ...(device.uiCache === undefined ? {} : { uiCache: { ...device.uiCache } })
    })),
    tools: Object.fromEntries(TOOL_NAMES.flatMap((name) => {
      const version = report.environment.tools[name];
      return version !== undefined && VERSION.test(version) ? [[name, version]] : [];
    })),
    layers: { ...report.layers },
    ...(failure === undefined
      ? {}
      : {
          primaryFailure: {
            code: failure.code,
            phase: TOKEN.test(failure.phase) ? failure.phase : "other",
            ...(failure.stepIndex === undefined ? {} : { stepIndex: failure.stepIndex })
          }
        }),
    secondaryErrorCodes: report.secondaryErrors.map((error) => error.code),
    fallbackUsed: report.fallbackUsed,
    logcatEvidence: (report.logcatEvidence ?? []).map((entry) => ({
      device: redact.device(entry.role),
      droppedLines: entry.droppedLines,
      droppedBytes: entry.droppedBytes
    })),
    steps: report.steps.map((step) => summarizeStep(step, redact))
  };
}
