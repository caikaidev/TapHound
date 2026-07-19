import { Command } from "commander";

import { createDoctorCommand } from "./commands/doctor.js";
import { createRecordCommand } from "./commands/record.js";
import { createVerifyCommand } from "./commands/verify.js";
import {
  createProductionDependencies,
  type CliDependencies
} from "./dependencies.js";

export function createProgram(
  dependencies: CliDependencies = createProductionDependencies()
): Command {
  const configureOutput = (command: Command): Command => command.configureOutput({
    writeOut: (content): void => {
      dependencies.stdout.write(content);
    },
    writeErr: (content): void => {
      dependencies.stderr.write(content);
    }
  });
  return new Command()
    .name("apr")
    .description("Deterministic Android Journey verification")
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
    .addCommand(configureOutput(createVerifyCommand(dependencies)));
}
