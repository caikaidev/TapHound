import { Command } from "commander";

export function createProgram(): Command {
  return new Command()
    .name("apr")
    .description("Deterministic Android Journey verification")
    .addCommand(new Command("doctor"))
    .addCommand(new Command("record"))
    .addCommand(new Command("verify"));
}
