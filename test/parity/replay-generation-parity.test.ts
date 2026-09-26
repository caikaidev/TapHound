import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { demoApp, scenarios } from "../harness/demo-app.js";
import {
  createParityProject,
  finalizeGeneration,
  runGeneration,
  runReplay,
  type ParityProject
} from "../harness/parity-runner.js";

/**
 * Golden parity: Replay and Generation must reach the same per-step verdicts
 * on the same simulated device. Device-call counts are pinned in a file
 * snapshot so performance work shows up as a reviewed diff.
 */
// Each scenario runs real Replay, Generation, and (on success) finalization
// through the durable session Store, so it is fsync-bound under load.
const SCENARIO_TIMEOUT_MS = 120_000;

describe("Replay ↔ Generation parity on a simulated device", () => {
  let project: ParityProject;

  beforeAll(async () => {
    project = await createParityProject();
  }, 60_000);

  afterAll(async () => {
    await project.dispose();
  }, 60_000);

  const deviceCalls: Record<string, unknown> = {};

  for (const scenario of scenarios) {
    it(`agrees on "${scenario.name}"`, async () => {
      const replay = await runReplay(demoApp, project, scenario.journey);
      const generation = await runGeneration(demoApp, project, scenario.journey);

      expect(replay.outcomes.map((step) => step.outcome)).toEqual(scenario.expected);
      expect(generation.outcomes.map((step) => step.outcome)).toEqual(scenario.expected);
      for (const [index, step] of generation.outcomes.entries()) {
        if (step.outcome !== "passed") continue;
        expect(step, `step ${String(index)} Activities`).toMatchObject({
          before: replay.outcomes[index]?.before,
          after: replay.outcomes[index]?.after
        });
      }
      if (scenario.expected.every((outcome) => outcome === "passed")) {
        await expect(finalizeGeneration(project, generation)).resolves.toBe("verified");
      }
      deviceCalls[scenario.name] = {
        replay: replay.stepCalls,
        generation: generation.stepCalls
      };
    }, SCENARIO_TIMEOUT_MS);
  }

  it("pins per-step device calls for both engines", async () => {
    await expect(`${JSON.stringify(deviceCalls, null, 2)}\n`)
      .toMatchFileSnapshot("./__snapshots__/device-calls.json");
  });
});
