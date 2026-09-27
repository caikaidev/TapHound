
import { Command } from "commander";

import type { CliDependencies } from "../dependencies.js";
import {
  createFinalizeCommand,
  createRecoverCommand,
  createReopenCommand
} from "./generation/lifecycle-commands.js";
import {
  createArchiveCommand,
  createConfigCommand,
  createListCommand,
  createObserveCommand,
  createStartCommand,
  createStatusCommand
} from "./generation/session-commands.js";
import {
  createBridgeCommand,
  createConfirmCommand,
  createManualCommand,
  createStepCommand
} from "./generation/step-commands.js";

export function createGenerationCommand(
  dependencies: CliDependencies
): Command {
  return new Command("generation")
    .description("Manage deterministic generation sessions")
    .addCommand(createStartCommand(dependencies))
    .addCommand(createObserveCommand(dependencies))
    .addCommand(createStepCommand(dependencies))
    .addCommand(createConfirmCommand(dependencies))
    .addCommand(createManualCommand(dependencies))
    .addCommand(createBridgeCommand(dependencies))
    .addCommand(createStatusCommand(dependencies))
    .addCommand(createRecoverCommand(dependencies))
    .addCommand(createReopenCommand(dependencies))
    .addCommand(createArchiveCommand(dependencies))
    .addCommand(createConfigCommand(dependencies))
    .addCommand(createListCommand(dependencies))
    .addCommand(createFinalizeCommand(dependencies));
}
