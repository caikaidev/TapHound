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
  ContextLoadError
} from "../../application/context/context-loader.js";
import type {
  RuntimeObservation
} from "../../application/generation/runtime-observer.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import type { TapHoundConfig } from "../../domain/config.js";
import { GenerationSessionIdSchema } from "../../domain/generation.js";
import { ProposedStepSchema } from "../../domain/proposed-step.js";
import { RuntimeSnapshotSchema } from "../../domain/runtime-snapshot.js";
import { JOBS_DIR } from "../../domain/workspace.js";
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
import { assertNoLegacyWorkspace } from "../workspace-guard.js";

interface GenerationStartOptions {
  project: string;
  config: string;
  context: string;
  module?: string[] | undefined;
  device?: string | undefined;
  allowEvidenceDrift?: boolean | undefined;
  baseFlow?: string | undefined;
  json?: boolean | undefined;
}

interface GenerationObserveOptions {
  project: string;
  config: string;
  session: string;
  json?: boolean | undefined;
}

interface GenerationStatusOptions extends GenerationObserveOptions {
  wait?: boolean | undefined;
  timeoutMs?: string | undefined;
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
  allowEvidenceDrift?: boolean | undefined;
  detach?: boolean | undefined;
}

interface GenerationRecoverOptions extends GenerationObserveOptions {
  decision: string;
}

type GenerationOptions =
  | GenerationStartOptions
  | GenerationObserveOptions
  | GenerationStepOptions
  | GenerationConfirmOptions
  | GenerationManualOptions
  | GenerationRecoverOptions
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
  error: unknown,
  outputOptions: {
    status?: "error" | "recoveryRequired";
    details?: unknown;
    generationId?: string;
  } = {}
): void {
  const output = {
    status: outputOptions.status ?? "error",
    exitCode,
    ...(outputOptions.generationId === undefined
      ? {}
      : { generationId: outputOptions.generationId }),
    failure: {
      code,
      message: errorMessage(error),
      ...(outputOptions.details !== undefined
        ? { details: outputOptions.details }
        : error instanceof GenerationOperationError
          && error.details !== undefined
          ? { details: error.details }
          : {})
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
    const config = TapHoundConfigSchema.parse(await dependencies.readJson(
      resolve(options.project, options.config)
    ));
    await assertNoLegacyWorkspace(dependencies, options.project);
    return config;
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
  if (error instanceof ContextLoadError) {
    writeFailure(
      dependencies,
      options,
      error.code === "CONTEXT_STALE" ? 1 : 2,
      error.code,
      error
    );
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
  if (error instanceof GenerationFinalizationError) {
    writeFailure(dependencies, options, 1, error.code, error);
    return;
  }
  if (error instanceof GenerationOperationError) {
    const exitCode = error.code === "CONFIG_INVALID"
      || error.code === "CONTEXT_INVALID"
      || error.code === "FLOW_INVALID"
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
      result.failure.message,
      {
        status: "recoveryRequired",
        generationId: input.generationId,
        ...(result.failure.details === undefined
          ? {}
          : { details: result.failure.details })
      }
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
    source: input.source,
    ...(result.nextObservation === undefined
      ? {}
      : {
          nextBinding: result.nextObservation.binding,
          nextSnapshot: result.nextObservation.snapshot
        }),
    ...(result.nextObservationFailure === undefined
      ? {}
      : { nextObservationFailure: result.nextObservationFailure })
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

async function assertRuntimeConfig(
  runtime: NonNullable<ReturnType<NonNullable<CliDependencies["generationRuntime"]>>>,
  generationId: string
): Promise<void> {
  await runtime.assertConfigIdentity(generationId);
}

function createStartCommand(dependencies: CliDependencies): Command {
  return new Command("start")
    .description("Start a Core-owned generation session")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", "taphound.config.json")
    .requiredOption("--context <path>", "Project Context path")
    .option("--module <id...>", "Select Context modules for this session")
    .option("--device <serial>", "Select an online Android device")
    .option(
      "--base-flow <name>",
      "Replay a reusable Flow before AI step generation"
    )
    .option(
      "--allow-evidence-drift",
      "Allow changed source evidence; replay remains mandatory"
    )
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationStartOptions): Promise<void> => {
      try {
        const config = await loadConfig(dependencies, options);
        const loaded = await dependencies.contextLoader.load({
          projectRoot: options.project,
          contextPath: resolve(options.project, options.context),
          ...(options.module === undefined ? {} : { moduleIds: options.module })
        });
        const context = loaded.context;
        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
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
          throw new Error("Doctor did not select a device");
        }
        const project = await dependencies.projectDescriber.describe({
          projectRoot: options.project,
          config,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        const baseFlow = options.baseFlow === undefined
          ? undefined
          : await (async (): Promise<NonNullable<
              Parameters<CliDependencies["generationStarter"]["start"]>[0]["baseFlow"]
            >> => {
              if (dependencies.journeyResolver === undefined) {
                throw new GenerationOperationError(
                  "FLOW_INVALID",
                  "Journey Flow resolver is unavailable"
                );
              }
              const resolution = await dependencies.journeyResolver.resolveFlow({
                projectRoot: options.project,
                name: options.baseFlow as string
              }).catch((error: unknown) => {
                throw new GenerationOperationError(
                  "FLOW_INVALID",
                  errorMessage(error)
                );
              });
              writeLine(
                dependencies.stderr,
                `TapHound: replaying base Flow ${options.baseFlow as string}`
              );
              const verification = await dependencies.verifier.verify({
                config,
                journey: resolution.journey,
                projectRoot: options.project,
                deviceSerial,
                toolVersions: tools(doctor.checks),
                requireFocusedInput: true,
                generatedReplayPolicy: true,
                ...(dependencies.signal === undefined
                  ? {}
                  : { signal: dependencies.signal })
              });
              if (
                verification.status !== "passed"
                || verification.exitCode !== 0
              ) {
                throw new GenerationOperationError(
                  "FLOW_REPLAY_FAILED",
                  verification.report.primaryFailure?.message
                    ?? `Base Flow ${options.baseFlow as string} did not replay cleanly`
                );
              }
              return {
                name: options.baseFlow as string,
                resolutionSha256: resolution.manifest.resolutionSha256,
                journey: resolution.journey,
                verificationReport: verification.report
              };
            })();
        const session = await dependencies.generationStarter.start({
          projectRoot: options.project,
          config,
          context,
          project,
          deviceSerial,
          ...(baseFlow === undefined ? {} : { baseFlow }),
          ...(options.allowEvidenceDrift === true
            ? { allowEvidenceDrift: true }
            : {})
        });
        const output = {
          status: "started" as const,
          exitCode: 0 as const,
          generationId: session.id,
          revision: session.revision,
          bindings: session.bindings,
          contextSelection: session.contextSelection,
          ...(options.allowEvidenceDrift === true
            ? { evidenceDriftAllowed: true }
            : {}),
          variables: session.variables,
          target: session.target,
          ...(session.baseFlow === undefined
            ? {}
            : { baseFlow: session.baseFlow })
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
        const config = await loadConfig(dependencies, options);
        const observation = dependencies.generationRuntime === undefined
          ? await dependencies.runtimeObserver.observe({
              projectRoot: options.project,
              generationId,
              idle: config.idle,
              ...(dependencies.signal === undefined
                ? {}
                : { signal: dependencies.signal })
            })
          : await (async (): Promise<RuntimeObservation> => {
              const runtime = requireRuntime(
                dependencies,
                options.project,
                config
              );
              await assertRuntimeConfig(runtime, generationId);
              return runtime.observer.observe({
                generationId,
                idle: config.idle,
                ...(dependencies.signal === undefined
                  ? {}
                  : { signal: dependencies.signal })
              });
            })();
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
          error instanceof GenerationSessionStoreError
          && (
            error.code === "REVISION_CONFLICT"
            || error.code === "INVALID_TRANSITION"
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
      const runtime = requireRuntime(dependencies, options.project, config);
      await assertRuntimeConfig(runtime, generationId);
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
      await assertRuntimeConfig(runtime, generationId);
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
      await assertRuntimeConfig(runtime, generationId);
      const existing = await runtime.confirmation.findPendingManual({
        generationId,
        action
      });
      if (existing !== null) {
        const session = await runtime.readSession(generationId);
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: session.revision,
          challenge: existing.challenge
        }, `Confirmation required: ${existing.challenge.challengeId}`);
        return;
      }
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
      .option("--device <serial>", "Select an online Android device")
      .option(
        "--allow-evidence-drift",
        "Allow changed source evidence; replay remains mandatory"
      )
      .option(
        "--detach",
        "Run verification in a detached process and return immediately"
      ),
    dependencies
  ).action(async (options: GenerationFinalizeOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const config = await loadConfig(dependencies, options);
      const outputPath = GenerationOutputPathSchema.parse(options.output);
      const name = options.name === undefined
        ? undefined
        : z.string().trim().min(1).parse(options.name);
      const runtime = requireRuntime(dependencies, options.project, config);
      await assertRuntimeConfig(runtime, generationId);
      const session = await runtime.readSession(generationId);
      if (options.detach === true) {
        if (
          dependencies.detachedProcess === undefined
          || dependencies.cliEntryPath === undefined
          || dependencies.createDetachedJobId === undefined
        ) {
          throw new Error("Detached finalization is unavailable");
        }
        const jobId = dependencies.createDetachedJobId();
        const outputJobPath =
          `${JOBS_DIR}/${generationId}/${jobId}-output.json`;
        const progressJobPath =
          `${JOBS_DIR}/${generationId}/${jobId}-progress.log`;
        const args = [
          dependencies.cliEntryPath,
          "generation",
          "finalize",
          "--project",
          options.project,
          "--config",
          options.config,
          "--session",
          generationId,
          "--context",
          options.context,
          "--output",
          options.output,
          ...(options.name === undefined ? [] : ["--name", options.name]),
          ...(options.device === undefined
            ? []
            : ["--device", options.device]),
          ...(options.allowEvidenceDrift === true
            ? ["--allow-evidence-drift"]
            : []),
          "--json"
        ];
        const launched = await dependencies.detachedProcess.launch({
          executable: process.execPath,
          args,
          cwd: options.project,
          stdoutPath: resolve(options.project, outputJobPath),
          stderrPath: resolve(options.project, progressJobPath)
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
      const loaded = await dependencies.contextLoader.load({
        projectRoot: options.project,
        contextPath: resolve(options.project, options.context),
        moduleIds: session.contextSelection.modules.map((module) => module.id)
      });
      const context = loaded.context;
      const doctor = await dependencies.doctor.run({
        packageName: config.run.packageName,
        skipPermissionProbe: true,
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
        projectRoot: options.project,
        config,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      const result = await runtime.finalizer.finalize({
        generationId,
        projectRoot: options.project,
        config,
        context,
        project,
        outputPath,
        ...(name === undefined ? {} : { name }),
        deviceSerial,
        ...(options.allowEvidenceDrift === true
          ? { allowEvidenceDrift: true }
          : {}),
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
        replayed: result.replayed,
        ...(options.allowEvidenceDrift === true
          ? { evidenceDriftAllowed: true }
          : {})
      }, `Generation verified: ${result.journeyPath}`);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

function createStatusCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("status")
      .description("Inspect durable generation session state")
      .option("--wait", "Wait until generation reaches a terminal state")
      .option(
        "--timeout-ms <milliseconds>",
        "Maximum status wait time",
        "900000"
      ),
    dependencies
  ).action(async (options: GenerationStatusOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const config = await loadConfig(dependencies, options);
      const runtime = requireRuntime(dependencies, options.project, config);
      await assertRuntimeConfig(runtime, generationId);
      const timeoutMs = z.coerce.number().int().positive().parse(
        options.timeoutMs ?? "900000"
      );
      const deadline = Date.now() + timeoutMs;
      let status = await runtime.recovery.status(generationId);
      while (
        options.wait === true
        && status.publication.status !== "published"
        && status.verification.status !== "failed"
        && status.state !== "recoveryRequired"
        && !(
          status.verification.status === "running"
          && status.recovery.available
        )
      ) {
        if (dependencies.signal?.aborted === true) {
          throw new GenerationOperationError(
            "RECOVERY_REQUIRED",
            "Generation status wait was cancelled"
          );
        }
        if (Date.now() >= deadline) {
          throw new GenerationOperationError(
            "FINALIZATION_IN_PROGRESS",
            "Generation did not reach a terminal state before status timeout"
          );
        }
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, Math.min(500, deadline - Date.now()));
        });
        status = await runtime.recovery.status(generationId);
      }
      writeSuccess(
        dependencies,
        options,
        { status: "inspected", exitCode: 0, ...status },
        `Generation ${generationId}: ${status.state}`
      );
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

function createRecoverCommand(dependencies: CliDependencies): Command {
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
      const config = await loadConfig(dependencies, options);
      const runtime = requireRuntime(dependencies, options.project, config);
      await assertRuntimeConfig(runtime, generationId);
      const before = await runtime.recovery.status(generationId);
      if (!before.recovery.available) {
        throw new GenerationOperationError(
          "RECOVERY_REQUIRED",
          "Generation session has no recoverable in-flight step"
        );
      }
      const session = await runtime.recovery.retry(generationId);
      writeSuccess(dependencies, options, {
        status: "recovered",
        exitCode: 0,
        generationId,
        revision: session.revision,
        actionMayHaveExecuted: before.recovery.actionMayHaveExecuted,
        previousAttemptOutcome: before.recovery.attemptOutcome
      }, `Generation ${generationId} recovered for explicit retry`);
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
    .addCommand(createStatusCommand(dependencies))
    .addCommand(createRecoverCommand(dependencies))
    .addCommand(createFinalizeCommand(dependencies));
}
