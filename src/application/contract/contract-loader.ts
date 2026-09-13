import { createHash } from "node:crypto";

import {
  AcceptanceContractSchema,
  type AcceptanceContract
} from "../../domain/contract.js";
import type { FailureCode } from "../../domain/failure.js";
import {
  JourneySchema,
  type Journey
} from "../../domain/journey.js";
import { hashJourney } from "../../domain/report.js";
import { tapHoundPath } from "../../domain/workspace.js";

export class ContractError extends Error {
  public constructor(
    public readonly code: FailureCode,
    message: string
  ) {
    super(message);
    this.name = "ContractError";
  }
}

export interface LoadedContract {
  contract: AcceptanceContract;
  contractSha256: string;
  journey: Journey;
  journeyPath: string;
}

export interface ContractLoaderDependencies {
  readText: (path: string) => Promise<string>;
}

export function hashContractText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class ContractLoader {
  public constructor(private readonly dependencies: ContractLoaderDependencies) {}

  public readonly load = async (input: {
    projectRoot: string;
    workspaceRoot?: string | undefined;
    contractPath: string;
  }): Promise<LoadedContract> => {
    let contractText: string;
    try {
      contractText = await this.dependencies.readText(input.contractPath);
    } catch (error) {
      throw new ContractError(
        "CONTRACT_INVALID",
        `Cannot read Acceptance Contract at ${input.contractPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    let contract: AcceptanceContract;
    try {
      contract = AcceptanceContractSchema.parse(JSON.parse(contractText));
    } catch (error) {
      throw new ContractError(
        "CONTRACT_INVALID",
        `Acceptance Contract at ${input.contractPath} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const journeyPath = tapHoundPath(
      input.projectRoot,
      input.workspaceRoot,
      contract.journey.path
    );
    let journeyText: string;
    try {
      journeyText = await this.dependencies.readText(journeyPath);
    } catch (error) {
      throw new ContractError(
        "CONTRACT_JOURNEY_MISSING",
        `Bound Journey ${contract.journey.path} is missing: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    let journey: Journey;
    try {
      journey = JourneySchema.parse(JSON.parse(journeyText));
    } catch (error) {
      throw new ContractError(
        "CONTRACT_JOURNEY_MISSING",
        `Bound Journey ${contract.journey.path} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const journeySha256 = hashJourney(journey);
    if (journeySha256 !== contract.journey.sha256) {
      throw new ContractError(
        "CONTRACT_JOURNEY_DRIFT",
        `Bound Journey ${contract.journey.path} drifted: binding ${contract.journey.sha256}, found ${journeySha256}. Re-bind the contract to the current Journey or restore the bound content.`
      );
    }
    return {
      contract,
      contractSha256: hashContractText(contractText),
      journey,
      journeyPath
    };
  };
}