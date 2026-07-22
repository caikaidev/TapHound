import { Command } from "commander";

import { createContextCommand } from "./commands/context.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createProjectCommand } from "./commands/project.js";
import { createRecordCommand } from "./commands/record.js";
import { createVerifyCommand } from "./commands/verify.js";
import {
  createProductionDependencies,
  type CliDependencies
} from "./dependencies.js";

export function createProgram(
  dependencies: CliDependencies = createProductionDependencies()
): Command {
  const configureOutput = (command: Command): Command => {
    command.configureOutput({
      writeOut: (content): void => {
        dependencies.stdout.write(content);
      },
      writeErr: (content): void => {
        dependencies.stderr.write(content);
      }
    });
    for (const child of command.commands) {
      configureOutput(child);
    }
    return command;
  };
  return new Command()
    .name("taphound")
    .description("Deterministic app journey recording and verification")
    .configureOutput({
      writeOut: (content): void => {
        dependencies.stdout.write(content);
      },
      writeErr: (content): void => {
        dependencies.stderr.write(content);
      }
    })
    .addCommand(configureOutput(createDoctorCommand(dependencies)))
    .addCommand(configureOutput(createRecordCommand(dependencies)))
    .addCommand(configureOutput(createVerifyCommand(dependencies)))
    .addCommand(configureOutput(createProjectCommand(dependencies)))
    .addCommand(configureOutput(createContextCommand(dependencies)));
}
