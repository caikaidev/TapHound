import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProductionDependencies,
  type CliDependencies
} from "../../src/cli/dependencies.js";
import {
  TapHoundConfigSchema,
  type TapHoundConfig
} from "../../src/domain/config.js";
import type { Journey, JourneyStep } from "../../src/domain/journey.js";
import type { ProposalBinding, ProposedStep } from "../../src/domain/proposed-step.js";
import type { RuntimeSnapshot } from "../../src/domain/runtime-snapshot.js";
import {
  CONFIG_PATH,
  CONTEXT_INDEX_PATH,
  EXTERNAL_FLOWS_DIR
} from "../../src/domain/workspace.js";
import { CAMERA_FLOW, cameraFlow } from "./demo-app.js";
import { FakeClock } from "../fakes/fake-clock.js";
import {
  SIMULATED_SERIAL,
  SimulatedDevice,
  type SimulatedApp
} from "./simulated-device.js";

/**
 * Drives the production composition root against a SimulatedDevice so
 * Replay (`verify`) and Generation (`start → observe → step`) run the same
 * Journey through real Core services. Only the device is simulated.
 */

const DEMO_PROJECT = fileURLToPath(
  new URL("../../examples/taphound-android-demo", import.meta.url)
);

export const PARITY_CONFIG: TapHoundConfig = TapHoundConfigSchema.parse({
  version: 1,
  run: { packageName: "dev.taphound.demo", activity: ".MainActivity" },
  runtime: { backend: "adb" },
  idle: {
    strategy: "structural",
    pollIntervalMs: 1,
    stablePolls: 2,
    timeoutMs: 2000
  },
  ui: { backend: "auto", cacheEnabled: true }
});

export interface StepOutcome {
  index: number;
  /** `passed`, or the primary failure code. */
  outcome: string;
  before?: string | undefined;
  after?: string | undefined;
}

export interface EngineRun {
  outcomes: StepOutcome[];
  /** Device calls attributed to each attempted step. */
  stepCalls: Record<string, number>[];
}

export interface ParityProject {
  root: string;
  dispose: () => Promise<void>;
}

export async function createParityProject(): Promise<ParityProject> {
  const scratch = await mkdtemp(join(tmpdir(), "taphound-parity-"));
  const root = join(scratch, "demo");
  await cp(DEMO_PROJECT, root, {
    recursive: true,
    // Build outputs and IDE state are never Context evidence.
    filter: (source) => !["build", ".gradle", ".idea"].includes(basename(source))
  });
  await writeFile(
    join(root, CONFIG_PATH),
    `${JSON.stringify(PARITY_CONFIG, null, 2)}\n`
  );
  const flowPath = join(root, EXTERNAL_FLOWS_DIR, `${CAMERA_FLOW}.json`);
  await mkdir(dirname(flowPath), { recursive: true });
  await writeFile(flowPath, `${JSON.stringify(cameraFlow, null, 2)}\n`);
  return {
    root: await realpath(root),
    dispose: () => rm(scratch, { recursive: true, force: true })
  };
}

/**
 * Production wiring with the device and time simulated: every wait, poll, and
 * cache TTL runs on a virtual clock, so retry counts are deterministic and
 * timeouts cost no wall time.
 */
function dependencies(device: SimulatedDevice): CliDependencies {
  const clock = new FakeClock();
  clock.currentTime = 1_000_000;
  return createProductionDependencies(undefined, {
    runtimeBackend: device,
    clock
  });
}

function countsBetween(
  timeline: readonly string[],
  start: number,
  end: number
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const call of timeline.slice(start, end)) {
    counts.set(call, (counts.get(call) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

export async function runReplay(
  app: SimulatedApp,
  project: ParityProject,
  journey: Journey
): Promise<EngineRun> {
  const device = new SimulatedDevice(app);
  const boundaries: number[] = [];
  const result = await dependencies(device).verifier.verify({
    config: PARITY_CONFIG,
    journey,
    projectRoot: project.root,
    devices: [{ role: "default", deviceSerial: SIMULATED_SERIAL }],
    toolVersions: {},
    progress: (event): void => {
      if (event.stage === "replaying" || event.stage === "collecting") {
        boundaries.push(device.timeline.length);
      }
    }
  });
  const report = result.report;
  const outcomes = report.steps
    .filter((step) => step.status !== "notRun")
    .map((step): StepOutcome => ({
      index: step.index,
      outcome: step.status === "passed"
        ? "passed"
        : report.primaryFailure?.stepIndex === step.index
          ? report.primaryFailure.code
          : step.status,
      before: step.activity?.before.actual,
      after: step.activity?.after.actual
    }));
  const stepCalls = outcomes.map((_outcome, index) => countsBetween(
    device.timeline,
    boundaries[index] ?? device.timeline.length,
    boundaries[index + 1] ?? device.timeline.length
  ));
  return { outcomes, stepCalls };
}

/**
 * The proposal an agent submits for a Journey step: Core fills the after
 * Activity, and an auto bridge is proposed through its bound External Flow.
 */
function toProposal(step: JourneyStep, binding: ProposalBinding): ProposedStep {
  if (step.action === "bridge") {
    return {
      action: "bridge",
      scenario: step.scenario,
      description: step.description,
      triggerLocator: step.triggerLocator,
      returnTimeoutMs: step.returnTimeoutMs,
      flow: CAMERA_FLOW,
      ...(step.expect === undefined ? {} : { expect: step.expect }),
      activity: { before: step.activity.before },
      binding
    };
  }
  return {
    ...step,
    activity: { before: step.activity.before },
    binding
  } as ProposedStep;
}

function failureCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  throw error;
}

export async function runGeneration(
  app: SimulatedApp,
  project: ParityProject,
  journey: Journey
): Promise<EngineRun & { generationId: string; device: SimulatedDevice }> {
  const device = new SimulatedDevice(app);
  const deps = dependencies(device);
  const loaded = await deps.contextLoader.load({
    projectRoot: project.root,
    contextPath: join(project.root, CONTEXT_INDEX_PATH),
    allowIncomplete: true
  });
  const described = await deps.projectDescriber.describe({
    projectRoot: project.root,
    config: PARITY_CONFIG
  });
  const resolver = deps.externalFlowResolver;
  if (resolver === undefined) throw new Error("External Flow resolver unavailable");
  const camera = await resolver.resolve({
    projectRoot: project.root,
    name: CAMERA_FLOW
  });
  const session = await deps.generationStarter.start({
    projectRoot: project.root,
    config: PARITY_CONFIG,
    context: loaded.context,
    project: described,
    deviceSerial: SIMULATED_SERIAL,
    externalFlows: [{
      name: CAMERA_FLOW,
      flowSha256: camera.flowSha256,
      escapedPackageName: camera.flow.escapedPackageName,
      stepCount: camera.stepCount
    }]
  });
  const runtime = deps.generationRuntime?.({
    projectRoot: project.root,
    config: PARITY_CONFIG
  });
  if (runtime === undefined) throw new Error("Generation runtime unavailable");

  const outcomes: StepOutcome[] = [];
  const stepCalls: Record<string, number>[] = [];
  type Observation = { binding: ProposalBinding; snapshot: RuntimeSnapshot };
  let observation: Observation | undefined;
  for (const [index, step] of journey.steps.entries()) {
    device.resetCounts();
    observation ??= await runtime.observer.observe({
      generationId: session.id,
      idle: PARITY_CONFIG.idle
    });
    let outcome: StepOutcome;
    let next: Observation | undefined;
    try {
      const confirmation = await runtime.confirmation.request({
        generationId: session.id,
        proposal: toProposal(step, observation.binding),
        snapshot: observation.snapshot,
        source: "planner"
      });
      if (confirmation.status !== "approved") {
        throw new Error("Parity scenarios must not require confirmation");
      }
      const result = await runtime.executor.execute({
        generationId: session.id,
        proposal: confirmation.proposal,
        snapshot: confirmation.snapshot,
        source: "planner"
      });
      if (result.status === "succeeded") {
        outcome = {
          index,
          outcome: "passed",
          before: result.step.activity.before,
          after: result.step.activity.after
        };
        next = result.nextObservation;
      } else {
        outcome = { index, outcome: result.failure.code };
      }
    } catch (error) {
      outcome = { index, outcome: failureCode(error) };
    }
    outcomes.push(outcome);
    stepCalls.push(device.countsSnapshot());
    if (outcome.outcome !== "passed") break;
    observation = next;
  }
  return { outcomes, stepCalls, generationId: session.id, device };
}

export async function finalizeGeneration(
  project: ParityProject,
  run: { generationId: string; device: SimulatedDevice }
): Promise<string> {
  const deps = dependencies(run.device);
  const runtime = deps.generationRuntime?.({
    projectRoot: project.root,
    config: PARITY_CONFIG
  });
  if (runtime === undefined) throw new Error("Generation runtime unavailable");
  const result = await runtime.finalizer.finalize({
    generationId: run.generationId,
    projectRoot: project.root,
    config: PARITY_CONFIG,
    context: await runtime.readContextSnapshot(run.generationId),
    project: await deps.projectDescriber.describe({
      projectRoot: project.root,
      config: PARITY_CONFIG
    }),
    outputPath: ".taphound/journeys/parity-generated.json",
    deviceSerial: SIMULATED_SERIAL,
    manualReplay: false,
    toolVersions: {}
  });
  return result.status;
}
