import { Command } from "commander";

import { CONFIG_PATH } from "../../domain/workspace.js";
import {
  runDiffVerification,
  type DiffVerificationOptions
} from "../diff-verification.js";
import type { CliDependencies } from "../dependencies.js";

export function createVerifyChangesCommand(
  dependencies: CliDependencies
): Command {
  return new Command("verify-changes")
    .description("Replay the Journeys a Git change affects and report a verdict")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--base <ref>", "Base Git ref", "origin/main")
    .option("--head <ref>", "Head Git ref (defaults to HEAD, or WORKTREE with --target)")
    .option("--device <serial>", "Select an online Android device")
    .option("--scope <p0,p1,p2>", "Selection tiers to replay", "p0,p1")
    .option("--target <id>", "Registered local target id")
    .option("--targets <path>", "Targets workspace base path")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: DiffVerificationOptions): Promise<void> => {
      await runDiffVerification(dependencies, options);
    });
}