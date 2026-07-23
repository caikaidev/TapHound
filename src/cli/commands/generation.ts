import { resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import {
  GenerationFinalizationError,
  GenerationOutputPathSchema
} from "../../application/generation/generation-finalizer.js";
import {
  GenerationOperationError
} from "../../application/generation/generation-starter.js";
import {
  ProjectConfigurationError
} from "../../application/project/project-describer.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import type { TapHoundConfig } from "../../domain/config.js";
import { GenerationSessionIdSchema } from "../../domain/generation.js";
import { ProjectContextSchema } from "../../domain/project-context.js";
import { ProposedStepSchema } from "../../domain/proposed-step.js";
import { RuntimeSnapshotSchema } from "../../domain/runtime-snapshot.js";
import {
  GenerationSessionStoreError
} from "../../ports/generation-session-store.js";
import {
  GenerationPromptCancelledError
} from "../../ports/generation-prompt.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  writeJson,
  writeLine
} from "../output.js";

interface GenerationStartOptions {
  project: string;
  config: string;
  context: string;
  device?: string | undefined;
  json?: boolean | undefined;
}

interface GenerationObserveOptions {
  project: string;
  config: string;
  session: string;
  json?: boolean | undefined;
}

interface GenerationStepOptions extends GenerationObserveOptions {
  input: string;
}

interface GenerationConfirmOptions extends GenerationObserveOptions {
  challenge: string;
}

interface GenerationManualOptions extends GenerationObserveOptions {
  action: "click" | "longClick" | "inputText" | "swipe" | "scrollTo" | "back" | "wait";
}

interface GenerationFinalizeOptions extends GenerationObserveOptions {
  context: string;
  output: string;
  name?: string | undefined;
  device?: string | undefined;
}

type GenerationOptions =
  | GenerationStartOptions
  | GenerationObserveOptions
  | GenerationStepOptions
  | GenerationConfirmOptions
  | GenerationManualOptions
  | GenerationFinalizeOptions;

const PlannerEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  proposal: ProposedStepSchema,
  snapshot: RuntimeSnapshotSchema
});

const ManualActionSchema = z.enum([
  "click",
  "longClick",
  "inputText",
  "swipe",
  "scrollTo",
  "back",
  "wait"
]);

function writeFailure(
  dependencies: CliDependencies,
  options: GenerationOptions,
  exitCode: 1 | 2 | 3 | 4,
  code: string,
  error: unknown
): void {
  const output = {
    status: "error" as const,
    exitCode,
    failure: {
      code,
      message: errorMessage(error)
    }
  };
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

async function loadConfig(
  dependencies: CliDependencies,
  options: { project: string; config: string }
): Promise<TapHoundConfig> {
  try {
    return TapHoundConfigSchema.parse(await dependencies.readJson(
      resolve(options.project, options.config)
    ));
  } catch (error) {
    throw new GenerationOperationError(
      "CONFIG_INVALID",
      errorMessage(error)
    );
  }
}

function tools(
  checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]
): Record<string, string> {
  return Object.fromEntries(checks.flatMap((check) => (
    check.status === "passed" && check.version !== undefined
      ? [[check.name, check.version]]
      : []
  )));
}

function writeSuccess(
  dependencies: CliDependencies,
  options: GenerationOptions,
  output: Record<string, unknown>,
  message: string
): void {
  if (options.json === true) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stdout, message);
  }
  dependencies.setExitCode(0);
}

function mappedFailure(
  dependencies: CliDependencies,
  options: GenerationOptions,
  error: unknown
): void {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    writeFailure(dependencies, options, 2, "CONTEXT_INVALID", error);
    return;
  }
  if (dependencies.signal?.aborted === true) {
    writeFailure(
      dependencies,
      options,
      1,
      "RECOVERY_REQUIRED",
      "Generation command was cancelled"
    );
    return;
  }
  if (error instanceof ProjectConfigurationError) {
    writeFailure(dependencies, options, 2, "CONFIG_INVALID", error);
    return;
  }
  if (error instanceof GenerationFinalizationError) {
    writeFailure(dependencies, options, 1, error.code, error);
    return;
  }
  if (error instanceof GenerationOperationError) {
    const exitCode = error.code === "CONFIG_INVALID"
      || error.code === "CONTEXT_INVALID"
      ? 2
      : 1;
    writeFailure(dependencies, options, exitCode, error.code, error);
    return;
  }
  if (error instanceof GenerationSessionStoreError) {
    const exitCode = error.code === "INVALID_ID"
      || error.code === "INVALID_SESSION"
      || error.code === "INVALID_REVISION"
      ? 2
      : error.code === "IO_ERROR" || error.code === "LOCK_TIMEOUT"
        ? 4
        : 1;
    writeFailure(dependencies, options, exitCode, error.code, error);
    return;
  }
  if (
    error instanceof GenerationPromptCancelledError
  ) {
    writeFailure(
      dependencies,
      options,
      1,
      "RECOVERY_REQUIRED",
      error
    );
    return;
  }
  if (
    error instanceof Error
    && error.message.includes("requires local TTY")
  ) {
    writeFailure(
      dependencies,
      options,
      1,
      "RISK_CONFIRMATION_REQUIRED",
      error
    );
    return;
  }
  writeFailure(dependencies, options, 4, "INTERNAL_ERROR", error);
}

async function executeApproved(
  dependencies: CliDependencies,
  options: GenerationOptions,
  runtime: NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>>,
  input: {
    generationId: string;
    proposal: z.infer<typeof ProposedStepSchema>;
    snapshot: z.infer<typeof RuntimeSnapshotSchema>;
    source: "planner" | "manualOverride";
  }
): Promise<void> {
  const result = await runtime.executor.execute({
    ...input,
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal })
  });
  if (result.status !== "succeeded") {
    writeFailure(
      dependencies,
      options,
      1,
      result.failure.code,
      result.failure.message
    );
    return;
  }
  const session = await runtime.readSession(input.generationId);
  writeSuccess(dependencies, options, {
    status: "succeeded",
    exitCode: 0,
    generationId: input.generationId,
    revision: session.revision,
    stepIndex: session.candidateSteps.length - 1,
    step: result.step,
    source: input.source
  }, `Generation step ${String(session.candidateSteps.length - 1)} succeeded`);
}

function requireRuntime(
  dependencies: CliDependencies,
  projectRoot: string,
  config: TapHoundConfig
): NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>> {
  if (dependencies.generationRuntime === undefined) {
    throw new Error("Generation command runtime is unavailable");
  }
  return dependencies.generationRuntime({ projectRoot, config });
}

function createStartCommand(dependencies: CliDependencies): Command {
  return new Command("start")
    .description("Start a Core-owned generation session")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--context <path>", "Project Context path")
    .option("--device <serial>", "Select an online Android device")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationStartOptions): Promise<void> => {
      let config;
      try {
        config = TapHoundConfigSchema.parse(await dependencies.readJson(
          resolve(options.project, options.config)
        ));
      } catch (error) {
        writeFailure(dependencies, options, 2, "CONFIG_INVALID", error);
        return;
      }
      let context;
      try {
        context = ProjectContextSchema.parse(await dependencies.readJson(
          resolve(options.project, options.context)
        ));
      } catch (error) {
        writeFailure(
          dependencies,
          options,
          2,
          "CONTEXT_INVALID",
          error
        );
        return;
      }

      try {
        const doctor = await dependencies.doctor.run(
          options.project,
          dependencies.signal,
          options.device
        );
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
          throw new Error("Doctor did not select a device");
        }
        const project = await dependencies.projectDescriber.describe({
          projectRoot: options.project,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const session = await dependencies.generationStarter.start({
          projectRoot: options.project,
          config,
          context,
          project,
          deviceSerial
        });
        const output = {
          status: "started" as const,
          exitCode: 0 as const,
          generationId: session.id,
          revision: session.revision,
          bindings: session.bindings,
          variables: session.variables,
          target: session.target
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Generation started: ${session.id}`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        if (error instanceof GenerationOperationError) {
          const exitCode = error.code === "CONTEXT_STALE" ? 1 : 2;
          writeFailure(
            dependencies,
            options,
            exitCode,
            error.code,
            error
          );
          return;
        }
        if (error instanceof ProjectConfigurationError) {
          writeFailure(
            dependencies,
            options,
            2,
            "CONFIG_INVALID",
            error
          );
          return;
        }
        mappedFailure(dependencies, options, error);
      }
    });
}

function createObserveCommand(dependencies: CliDependencies): Command {
  return new Command("observe")
    .description("Observe and bind authoritative runtime state")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--session <id>", "Generation session id")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationObserveOptions): Promise<void> => {
      try {
        const generationId = GenerationSessionIdSchema.parse(options.session);
        await loadConfig(dependencies, options);
        const observation = await dependencies.runtimeObserver.observe({
          projectRoot: options.project,
          generationId,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const output = {
          status: "observed" as const,
          exitCode: 0 as const,
          ...observation.binding,
          snapshot: observation.snapshot
        };
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(
            dependencies.stdout,
            `Generation observed at revision ${
              String(observation.binding.baseRevision)
            }`
          );
        }
        dependencies.setExitCode(0);
      } catch (error) {
        if (error instanceof GenerationOperationError) {
          mappedFailure(dependencies, options, error);
          return;
        }
        if (
          (
            error instanceof GenerationOperationError
            && error.code === "SNAPSHOT_STALE"
          )
          || (
            error instanceof GenerationSessionStoreError
            && (
              error.code === "REVISION_CONFLICT"
              || error.code === "INVALID_TRANSITION"
            )
          )
        ) {
          writeFailure(
            dependencies,
            options,
            1,
            "SNAPSHOT_STALE",
            error
          );
          return;
        }
        mappedFailure(dependencies, options, error);
      }
    });
}

function addCommonOptions(
  command: Command,
  dependencies: CliDependencies
): Command {
  return command
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--session <id>", "Generation session id")
    .option("--json", "Emit one machine-readable JSON value");
}

function createStepCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("step")
      .description("Accept and execute one strict planner proposal")
      .requiredOption("--input <path>", "Strict proposal envelope path"),
    dependencies
  ).action(async (options: GenerationStepOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const config = await loadConfig(dependencies, options);
      let envelope: z.infer<typeof PlannerEnvelopeSchema>;
      try {
        envelope = PlannerEnvelopeSchema.parse(await dependencies.readJson(
          resolve(options.project, options.input)
        ));
      } catch (error) {
        throw new GenerationOperationError(
          "CONTEXT_INVALID",
          errorMessage(error)
        );
      }
      const runtime = requireRuntime(dependencies, options.project, config);
      const confirmation = await runtime.confirmation.request({
        generationId,
        proposal: envelope.proposal,
        snapshot: envelope.snapshot,
        source: "planner"
      });
      if (confirmation.status === "confirmationRequired") {
        const session = await runtime.readSession(generationId);
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: session.revision,
          challenge: confirmation.challenge
        }, `Confirmation required: ${confirmation.challenge.challengeId}`);
        return;
      }
      await executeApproved(dependencies, options, runtime, {
        generationId,
        proposal: confirmation.proposal,
        snapshot: envelope.snapshot,
        source: "planner"
      });
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

function createConfirmCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("confirm")
      .description("Approve and execute Core-owned challenge evidence")
      .requiredOption("--challenge <id>", "Core confirmation challenge id"),
    dependencies
  ).action(async (options: GenerationConfirmOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const challengeId = GenerationSessionIdSchema.parse(options.challenge);
      const config = await loadConfig(dependencies, options);
      const runtime = requireRuntime(dependencies, options.project, config);
      const approved = await runtime.confirmation.confirmStored({
        generationId,
        challengeId,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      await executeApproved(dependencies, options, runtime, {
        generationId,
        proposal: approved.proposal,
        snapshot: approved.snapshot,
        source: approved.source
      });
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

function createManualCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("manual")
      .description("Build one local TTY manual override proposal")
      .requiredOption("--action <action>", "Exact ProposedStep action"),
    dependencies
  ).action(async (options: GenerationManualOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const action = ManualActionSchema.parse(options.action);
      const config = await loadConfig(dependencies, options);
      const runtime = requireRuntime(dependencies, options.project, config);
      const observation = await runtime.observer.observe({
        generationId,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      const confirmation = await runtime.confirmation.requestManual({
        generationId,
        snapshot: observation.snapshot,
        manual: {
          action,
          binding: observation.binding,
          before: observation.snapshot.activity,
          layout: observation.snapshot.layout
        },
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      if (confirmation.status === "confirmationRequired") {
        const session = await runtime.readSession(generationId);
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: session.revision,
          challenge: confirmation.challenge
        }, `Confirmation required: ${confirmation.challenge.challengeId}`);
        return;
      }
      await executeApproved(dependencies, options, runtime, {
        generationId,
        proposal: confirmation.proposal,
        snapshot: observation.snapshot,
        source: "manualOverride"
      });
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

function createFinalizeCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("finalize")
      .description("Verify and publish a generated Journey")
      .requiredOption("--context <path>", "Project Context path")
      .requiredOption("--output <path>", "Project-relative Journey output")
      .option("--name <name>", "Generated Journey name")
      .option("--device <serial>", "Select an online Android device"),
    dependencies
  ).action(async (options: GenerationFinalizeOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const config = await loadConfig(dependencies, options);
      let context: z.infer<typeof ProjectContextSchema>;
      try {
        context = ProjectContextSchema.parse(await dependencies.readJson(
          resolve(options.project, options.context)
        ));
      } catch (error) {
        throw new GenerationOperationError(
          "CONTEXT_INVALID",
          errorMessage(error)
        );
      }
      const outputPath = GenerationOutputPathSchema.parse(options.output);
      const name = options.name === undefined
        ? undefined
        : z.string().trim().min(1).parse(options.name);
      const doctor = await dependencies.doctor.run(
        options.project,
        dependencies.signal,
        options.device
      );
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
        projectRoot: options.project,
        config,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      const runtime = requireRuntime(dependencies, options.project, config);
      const result = await runtime.finalizer.finalize({
        generationId,
        projectRoot: options.project,
        config,
        context,
        project,
        outputPath,
        ...(name === undefined ? {} : { name }),
        deviceSerial,
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
    .addCommand(createFinalizeCommand(dependencies));
}
