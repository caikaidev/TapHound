import { resolve } from "node:path";

import type { IdlePolicy } from "../../domain/config.js";
import { GenerationMetaSchema } from "../../domain/generation.js";
import type { Journey } from "../../domain/journey.js";
import { hashJourney } from "../../domain/report.js";
import { generationMetaOutputPath } from "./generation-publisher.js";

export interface PublishedReplayPolicy {
  generatedReplayPolicy: boolean;
  requireFocusedInput: boolean;
  idle: IdlePolicy;
}

export class ReplayPolicyUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReplayPolicyUnavailableError";
  }
}

export async function loadPublishedReplayPolicy(input: {
  readJson: (path: string) => Promise<unknown>;
  projectRoot: string;
  journeyPath: string;
  journey: Journey;
}): Promise<PublishedReplayPolicy> {
  const metaPath = generationMetaOutputPath(input.journeyPath);
  try {
    const meta = GenerationMetaSchema.parse(await input.readJson(metaPath));
    if (
      resolve(input.projectRoot, meta.journeyPath) !== resolve(input.journeyPath)
      || meta.journeySha256 !== hashJourney(input.journey)
      || !meta.replayPolicy.generatedReplayPolicy
      || !meta.replayPolicy.requireFocusedInput
    ) {
      throw new ReplayPolicyUnavailableError(
        "Generation meta does not bind this Journey and its strict Replay policy"
      );
    }
    return meta.replayPolicy;
  } catch (error) {
    if (error instanceof ReplayPolicyUnavailableError) {
      throw error;
    }
    throw new ReplayPolicyUnavailableError(
      `Cannot load a valid strict Replay policy from ${metaPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
