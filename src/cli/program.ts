import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { createContextCommand } from "./commands/context.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createGenerationCommand } from "./commands/generation.js";
import { createInitCommand } from "./commands/init.js";
import { createJourneyCommand } from "./commands/journey.js";
import { createObserveCommand } from "./commands/observe.js";
import { createProjectCommand } from "./commands/project.js";
import { createRecordCommand } from "./commands/record.js";
import { createVerifyCommand } from "./commands/verify.js";
import { createAlignCommand } from "./commands/align.js";
import {
  createProductionDependencies,
  type CliDependencies
} from "./dependencies.js";

function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

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
    .version(readCliVersion(), "-v, --version")
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
    .addCommand(configureOutput(createObserveCommand(dependencies)))
    .addCommand(configureOutput(createProjectCommand(dependencies)))
    .addCommand(configureOutput(createContextCommand(dependencies)))
    .addCommand(configureOutput(createJourneyCommand(dependencies)))
    .addCommand(configureOutput(createGenerationCommand(dependencies)))
    .addCommand(configureOutput(createInitCommand(dependencies)))
    .addCommand(configureOutput(createAlignCommand(dependencies)));
}
