import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { demoApp, scenarios } from "../harness/demo-app.js";
import type { JourneyStep } from "../../src/domain/journey.js";
import {
  amendGeneration,
  createParityProject,
  runRecording,
  finalizeGeneration,
  runGeneration,
  runReplay,
  type ParityProject
} from "../harness/parity-runner.js";

/** The Recorder never invents expectations, inside or outside the app. */
function withoutExpectations(step: JourneyStep): JourneyStep {
  const stripped: JourneyStep = { ...step };
  delete stripped.expect;
  if (stripped.action === "bridge" && stripped.externalSteps !== undefined) {
    return {
      ...stripped,
      externalSteps: stripped.externalSteps.map((external) => {
        const copy = { ...external };
        delete copy.expect;
        return copy;
      })
    };
  }
  return stripped;
}

/**
 * Golden parity: Replay (recorded and generated policy) and Generation must reach the same per-step verdicts
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
      const generatedReplay = await runReplay(
        demoApp,
        project,
        scenario.journey,
        "generated"
      );
      const generation = await runGeneration(demoApp, project, scenario.journey);

      expect(replay.outcomes.map((step) => step.outcome))
        .toEqual(scenario.recordedReplay ?? scenario.expected);
      expect(generatedReplay.outcomes.map((step) => step.outcome))
        .toEqual(scenario.expected);
      expect(generation.outcomes.map((step) => step.outcome))
        .toEqual(scenario.generation ?? scenario.expected);
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
        generatedReplay: generatedReplay.stepCalls,
        generation: generation.stepCalls
      };
    }, SCENARIO_TIMEOUT_MS);
  }

  for (const scenario of scenarios) {
    const moves = scenario.record;
    if (moves === undefined) continue;
    it(`records "${scenario.name}" as a Journey that replays`, async () => {
      const recording = await runRecording(demoApp, project, scenario.journey.name, moves);

      expect(recording.failures).toEqual([]);
      expect(recording.journey.steps).toEqual(
        scenario.journey.steps.map(withoutExpectations)
      );
      const replay = await runReplay(demoApp, project, recording.journey);
      expect(replay.outcomes.map((step) => step.outcome))
        .toEqual(recording.journey.steps.map(() => "passed"));
    }, SCENARIO_TIMEOUT_MS);
  }

  it("fails Replay when the bridge escapes to a different app than recorded", async () => {
    const camera = scenarios.find((scenario) => scenario.name.startsWith("camera"));
    const step = camera?.journey.steps[0];
    if (camera === undefined || step?.action !== "bridge") {
      throw new Error("camera bridge scenario is missing");
    }
    const recordedElsewhere: JourneyStep = {
      ...step,
      escapedPackageName: "com.vendor.camera"
    };
    const replay = await runReplay(demoApp, project, {
      ...camera.journey,
      steps: [recordedElsewhere]
    });

    expect(replay.outcomes.map((outcome) => outcome.outcome))
      .toEqual(["EXTERNAL_PACKAGE_MISMATCH"]);
    expect(replay.stepCalls[0]?.tap).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  it("amends a mistyped expectation on the current screen without replaying", async () => {
    const search = scenarios.find((scenario) => scenario.name === "search happy path");
    const open = search?.journey.steps[0];
    if (
      search === undefined
      || open?.action !== "click"
      || open.expect?.type !== "element"
    ) {
      throw new Error("search scenario is missing");
    }
    const typo: JourneyStep = {
      ...open,
      expect: { ...open.expect, locator: { resourceId: "search_inputt" } }
    };
    const generation = await runGeneration(demoApp, project, {
      ...search.journey,
      steps: [typo]
    });
    expect(generation.outcomes.map((step) => step.outcome))
      .toEqual(["EXPECT_ELEMENT_FAILED"]);

    // A still-wrong amendment leaves the step in recovery.
    const stillWrong = await amendGeneration(project, generation, {
      ...open.expect,
      locator: { resourceId: "search_field" }
    });
    expect(stillWrong.outcome).toBe("EXPECT_ELEMENT_FAILED");

    const amended = await amendGeneration(project, generation, open.expect);
    expect(amended.outcome).toBe("passed");
    // Only observation: no tap, no input, no launch, no force-stop.
    expect(Object.keys(amended.calls).filter((call) => (
      ["tap", "longClick", "inputText", "swipe", "back", "launchApp", "forceStop"]
        .includes(call)
    ))).toEqual([]);
    await expect(finalizeGeneration(project, generation)).resolves.toBe("verified");
    deviceCalls["amend expectation"] = {
      stillWrong: stillWrong.calls,
      amended: amended.calls
    };
  }, SCENARIO_TIMEOUT_MS);

  it("pins per-step device calls for both engines", async () => {
    await expect(`${JSON.stringify(deviceCalls, null, 2)}\n`)
      .toMatchFileSnapshot("./__snapshots__/device-calls.json");
  });
});
