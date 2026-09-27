// `generation` subcommands that verify and recover a session: finalize, recover, and reopen.

import { resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import {
  GenerationOutputPathSchema
} from "../../../application/generation/generation-finalizer.js";
import {
  GenerationOperationError
} from "../../../application/generation/generation-starter.js";
import {
  GenerationSessionIdSchema
} from "../../../domain/generation.js";
import {
  JOBS_DIR
} from "../../../domain/workspace.js";
import type { CliDependencies } from "../../dependencies.js";
import {
  writeLine
} from "../../output.js";
import {
  type GenerationFinalizeOptions,
  type GenerationRecoverOptions,
  type GenerationReopenOptions,
  addCommonOptions,
  assertRuntimeConfig,
  generationConfig,
  mappedFailure,
  requireRuntime,
  tools,
  writeFailure,
  writeSuccess
} from "./shared.js";

export function createFinalizeCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("finalize")
      .description("Verify and publish a generated Journey")
      .requiredOption(
        "--output <path>",
        "Journey output under .taphound/journeys"
      )
      .option("--name <name>", "Generated Journey name")
      .option("--device <serial>", "Select an online Android device")
      .option(
        "--detach",
        "Run verification in a detached process and return immediately"
      ),
    dependencies
  ).action(async (options: GenerationFinalizeOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const outputPath = GenerationOutputPathSchema.parse(options.output);
      const name = options.name === undefined
        ? undefined
        : z.string().trim().min(1).parse(options.name);
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const context = await runtime.readContextSnapshot(generationId);
      if (options.detach === true) {
        if (
          dependencies.detachedProcess === undefined
          || dependencies.cliEntryPath === undefined
          || dependencies.createDetachedJobId === undefined
        ) {
          throw new Error("Detached finalization is unavailable");
        }
        const jobId = dependencies.createDetachedJobId();
        const jobHome = projectRoot;
        const outputJobPath =
          `${JOBS_DIR}/${generationId}/${jobId}-output.json`;
        const progressJobPath =
          `${JOBS_DIR}/${generationId}/${jobId}-progress.log`;
        const args = [
          dependencies.cliEntryPath,
          "generation",
          "finalize",
          "--project",
          projectRoot,
          "--config",
          options.config,
          "--session",
          generationId,
          "--output",
          options.output,
          ...(options.name === undefined ? [] : ["--name", options.name]),
          ...(options.device === undefined
            ? []
            : ["--device", options.device]),
          "--json"
        ];
        const launched = await dependencies.detachedProcess.launch({
          executable: process.execPath,
          args,
          cwd: jobHome,
          stdoutPath: resolve(jobHome, outputJobPath),
          stderrPath: resolve(jobHome, progressJobPath)
        });
        writeSuccess(dependencies, options, {
          status: "finalizationStarted",
          exitCode: 0,
          generationId,
          jobId,
          ownerPid: launched.pid,
          outputPath: outputJobPath,
          progressPath: progressJobPath
        }, `Generation finalization started: ${generationId}`);
        return;
      }
      const verdict = await dependencies.contextValidator.validate({
        context,
        projectRoot,
        config
      });
      if (verdict.status !== "valid") {
        writeLine(
          dependencies.stderr,
          `TapHound warning: live project context drifted from the session snapshot (${verdict.reason.code}: ${verdict.reason.message}); the session snapshot remains authoritative`
        );
      }
      const doctor = await dependencies.doctor.run({
        packageName: config.run.packageName,
        skipPermissionProbe: true,
        ...(config.ui?.backend === undefined
          ? {}
          : { requestedUiBackend: config.ui.backend }),
        ...(options.device === undefined
          ? {}
          : { requestedDevice: options.device }),
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      if (doctor.status === "failed") {
        writeFailure(
          dependencies,
          options,
          3,
          doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
          doctor.checks.find((check) => check.status === "failed")?.message
            ?? "TapHound environment preflight failed"
        );
        return;
      }
      const deviceSerial = options.device ?? doctor.deviceSerial;
      if (deviceSerial === undefined) {
        writeFailure(
          dependencies,
          options,
          3,
          "DEVICE_UNAVAILABLE",
          "Doctor did not select a device"
        );
        return;
      }
      const project = await dependencies.projectDescriber.describe({
        projectRoot: projectRoot,
        config,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      const result = await runtime.finalizer.finalize({
        generationId,
        projectRoot: projectRoot,
        config,
        context,
        project,
        outputPath,
        ...(name === undefined ? {} : { name }),
        deviceSerial,
        manualReplay: process.stdin.isTTY,
        toolVersions: tools(doctor.checks),
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      writeSuccess(dependencies, options, {
        status: "verified",
        exitCode: 0,
        generationId,
        bundlePath: result.bundlePath,
        journeyPath: result.journeyPath,
        metaPath: result.metaPath,
        replayed: result.replayed
      }, `Generation verified: ${result.journeyPath}`);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

export function createRecoverCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("recover")
      .description("Explicitly reactivate an interrupted in-flight step")
      .requiredOption(
        "--decision <decision>",
        "Recovery decision; retry acknowledges the action may have executed"
      ),
    dependencies
  ).action(async (options: GenerationRecoverOptions): Promise<void> => {
    try {
      if (options.decision !== "retry") {
        throw new GenerationOperationError(
          "CONFIG_INVALID",
          "generation recover currently requires --decision retry"
        );
      }
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const before = await runtime.recovery.status(generationId);
      if (!before.recovery.available) {
        throw new GenerationOperationError(
          "RECOVERY_REQUIRED",
          "Generation session has no recoverable in-flight step"
        );
      }
      const session = await runtime.recovery.retry(generationId);
      const recoveryKind = before.recovery.kind;
      const nextAction = recoveryKind === "verification"
        ? "generation finalize"
        : "retry the interrupted generation step";
      writeSuccess(dependencies, options, {
        status: "recovered",
        exitCode: 0,
        generationId,
        revision: session.revision,
        recoveryKind,
        nextAction,
        actionMayHaveExecuted: before.recovery.actionMayHaveExecuted,
        previousAttemptOutcome: before.recovery.attemptOutcome
      }, recoveryKind === "verification"
        ? `Generation ${generationId} verification recovered. Rerun generation finalize to verify again.`
        : `Generation ${generationId} recovered. Explicitly retry the interrupted generation step.`);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

export function createReopenCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("reopen")
      .description("Reopen a deterministically failed verification for audited step repair")
      .requiredOption(
        "--reason <text>",
        "Reason for reopening the failed verification"
      ),
    dependencies
  ).action(async (options: GenerationReopenOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const { projectRoot, config } = await generationConfig(
        dependencies,
        options
      );
      const runtime = requireRuntime(
        dependencies,
        projectRoot,
        config
      );
      await assertRuntimeConfig(runtime, generationId);
      const session = await runtime.reopen.reopen({
        generationId,
        reason: options.reason
      });
      writeSuccess(dependencies, options, {
        status: "reopened",
        exitCode: 0,
        generationId,
        revision: session.revision,
        verification: session.verification,
        preservedFailure: session.verificationHistory.at(-1),
        nextAction: {
          command: "generation step --replace <index>",
          then: "generation finalize"
        }
      }, `Generation ${generationId} reopened. Repair with generation step --replace <index>, then rerun generation finalize.`);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}
