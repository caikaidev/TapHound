// `generation` subcommands that create, observe, inspect, list, archive, and configure sessions.

import { resolve } from "node:path";
import { createHash } from "node:crypto";

import { Command } from "commander";
import { z } from "zod";

import {
  GenerationOperationError,
  flowReplayFailureDetails
} from "../../../application/generation/generation-starter.js";
import type {
  RuntimeObservation
} from "../../../application/generation/runtime-observer.js";
import type {
  GenerationRecoveryStatus
} from "../../../application/generation/generation-recovery-service.js";
import {
  GenerationSessionIdSchema,
  verificationPhaseLabel,
  type GenerationSession
} from "../../../domain/generation.js";
import {
  DEFAULT_DEVICE_ROLE
} from "../../../domain/journey.js";
import { ProjectRelativePathSchema } from "../../../domain/project-context.js";
import {
  CONFIG_PATH,
  CONTEXT_INDEX_PATH,
  isJourneyBriefPath,
  JOURNEY_BRIEF_ROOTS
} from "../../../domain/workspace.js";
import {
  GenerationSessionStoreError
} from "../../../ports/generation-session-store.js";
import type { CliDependencies } from "../../dependencies.js";
import {
  errorMessage,
  writeJson,
  writeLine
} from "../../output.js";
import { canonicalProjectRoot } from "../../project-root.js";
import {
  type GenerationConfigIdleOptions,
  type GenerationListOptions,
  type GenerationObserveOptions,
  type GenerationStartOptions,
  type GenerationStatusOptions,
  addCommonOptions,
  assertRuntimeConfig,
  generationConfig,
  generationStatusText,
  loadConfig,
  mappedFailure,
  requireRuntime,
  tools,
  writeFailure,
  writeSuccess
} from "./shared.js";

export function createStartCommand(dependencies: CliDependencies): Command {
  return new Command("start")
    .description(
      "Start a Core-owned generation session"
        + " (the Journey path is chosen later with `generation finalize --output`)"
    )
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option(
      "--config <path>",
      "TapHound config path; later generation commands must pass the same --config",
      CONFIG_PATH
    )
    .option("--context <path>", "Project Context path")
    .option("--module <id...>", "Select Context modules for this session")
    .option("--device <serial>", "Select an online Android device")
    .option(
      "--base-flow <name>",
      "Replay a reusable Flow before AI step generation"
    )
    .option(
      "--external-flow <name...>",
      "Bind external app flow(s) for deterministic bridge replay"
    )
    .option(
      "--brief <path>",
      "Bind a project-relative Journey Brief by Core-computed content hash"
    )
    .option(
      "--allow-evidence-drift",
      "Allow changed source evidence; replay remains mandatory"
    )
    .option(
      "--compact",
      "Summarize contextSelection as indexHash plus module ids instead of per-module binding hashes"
    )
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationStartOptions): Promise<void> => {
      try {
        const projectRoot = await canonicalProjectRoot(
          dependencies.cwd(),
          options.project
        );
        const config = await loadConfig(dependencies, {
          project: projectRoot,
          config: options.config
        });
        const contextPath = resolve(
          projectRoot,
          options.context ?? CONTEXT_INDEX_PATH
        );
        const loaded = await dependencies.contextLoader.load({
          projectRoot,
          contextPath,
          allowIncomplete: true,
          ...(options.module === undefined ? {} : { moduleIds: options.module })
        });
        const context = loaded.context;
        const briefRequest = options.brief;
        const sourceBrief = briefRequest === undefined
          ? undefined
          : await (async (): Promise<{ path: string; sha256: string }> => {
            let briefPath: string;
            try {
              briefPath = ProjectRelativePathSchema.parse(briefRequest);
            } catch (error) {
              throw new GenerationOperationError(
                "BRIEF_INVALID",
                `Journey Brief path must stay within the project: ${briefRequest} (${
                  error instanceof Error ? error.message : String(error)
                })`
              );
            }
            if (!isJourneyBriefPath(briefPath)) {
              throw new GenerationOperationError(
                "BRIEF_INVALID",
                `Journey Brief must live under ${JOURNEY_BRIEF_ROOTS.join("/ or ")}/: ${briefPath}`
              );
            }
            let bytes: Buffer;
            try {
              bytes = await dependencies.readFile(
                resolve(projectRoot, briefPath)
              );
            } catch (error) {
              throw new GenerationOperationError(
                "BRIEF_INVALID",
                `Journey Brief is not readable: ${briefPath} (${
                  error instanceof Error ? error.message : String(error)
                })`
              );
            }
            return {
              path: briefPath,
              sha256: createHash("sha256").update(bytes).digest("hex")
            };
          })();
        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
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
          throw new Error("Doctor did not select a device");
        }
        const project = await dependencies.projectDescriber.describe({
          projectRoot,
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
                projectRoot,
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
                projectRoot,
                devices: [{
                  role: resolution.journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE,
                  deviceSerial
                }],
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
                    ?? `Base Flow ${options.baseFlow as string} did not replay cleanly`,
                  flowReplayFailureDetails({
                    flowName: options.baseFlow as string,
                    reportPath: verification.reportPath,
                    journey: resolution.journey,
                    report: verification.report
                  })
                );
              }
              return {
                name: options.baseFlow as string,
                resolutionSha256: resolution.manifest.resolutionSha256,
                journey: resolution.journey,
                verificationReport: verification.report,
                verificationReportPath: verification.reportPath
              };
            })();
        const externalFlows = options.externalFlow === undefined
          ? undefined
          : await (async (): Promise<NonNullable<
              Parameters<CliDependencies["generationStarter"]["start"]>[0]["externalFlows"]
            >> => {
            if (dependencies.externalFlowResolver === undefined) {
              throw new GenerationOperationError(
                "FLOW_INVALID",
                "External Flow resolver is unavailable"
              );
            }
            const flowNames = options.externalFlow as readonly string[];
            const resolved = [];
            for (const name of flowNames) {
              const resolution = await dependencies.externalFlowResolver
                .resolve({ projectRoot, name })
                .catch((error: unknown) => {
                  throw new GenerationOperationError(
                    "FLOW_INVALID",
                    `External Flow ${name}: ${errorMessage(error)}`
                  );
                });
              resolved.push({
                name,
                flowSha256: resolution.flowSha256,
                escapedPackageName: resolution.flow.escapedPackageName,
                stepCount: resolution.stepCount
              });
            }
            return resolved;
          })();
        const session = await dependencies.generationStarter.start({
          projectRoot,
          config,
          context,
          project,
          deviceSerial,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal }),
          ...(baseFlow === undefined ? {} : { baseFlow }),
          ...(externalFlows === undefined ? {} : { externalFlows }),
          ...(sourceBrief === undefined ? {} : { sourceBrief }),
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
          ...(options.compact === true
            ? {
                contextSelection: {
                  bundleVersion: session.contextSelection.bundleVersion,
                  indexHash: session.contextSelection.indexHash,
                  moduleIds: session.contextSelection.modules.map(
                    (module) => module.id
                  )
                }
              }
            : { contextSelection: session.contextSelection }),
          ...(options.allowEvidenceDrift === true
            ? { evidenceDriftAllowed: true }
            : {}),
          variables: session.variables,
          target: session.target,
          ...(session.baseFlow === undefined
            ? {}
            : { baseFlow: session.baseFlow }),
          ...(session.sourceBrief === undefined
            ? {}
            : { sourceBrief: session.sourceBrief }),
          ...(session.externalFlows.length === 0
            ? {}
            : { externalFlows: session.externalFlows })
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

export function createObserveCommand(dependencies: CliDependencies): Command {
  return new Command("observe")
    .description("Observe and bind authoritative runtime state")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .requiredOption("--session <id>", "Generation session id")
    .option(
      "--compact",
      "Emit binding plus authoritative snapshotRef instead of the full snapshot"
    )
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationObserveOptions): Promise<void> => {
      try {
        const generationId = GenerationSessionIdSchema.parse(options.session);
        const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
        const observation = dependencies.generationRuntime === undefined
          ? await dependencies.runtimeObserver.observe({
              projectRoot,
              generationId,
              idle: config.idle,
              ...(dependencies.signal === undefined
                ? {}
                : { signal: dependencies.signal })
            })
          : await (async (): Promise<RuntimeObservation> => {
              const runtime = requireRuntime(
                dependencies,
                projectRoot,
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
          snapshotRef: observation.snapshotRef,
          ...(options.compact === true
            ? {}
            : { snapshot: observation.snapshot })
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

export function createStatusCommand(dependencies: CliDependencies): Command {
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
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const timeoutMs = z.coerce.number().int().positive().parse(
        options.timeoutMs ?? "900000"
      );
      const deadline = Date.now() + timeoutMs;
      let status = await runtime.recovery.status(generationId);
      let reportedPhase: string | null = null;
      const reportPhaseProgress = (current: GenerationRecoveryStatus): void => {
        if (options.wait !== true) {
          return;
        }
        const phase = current.verification.status === "running"
          ? current.verification.phase
          : undefined;
        if (phase === undefined) {
          return;
        }
        const label = verificationPhaseLabel(phase);
        if (label !== reportedPhase) {
          reportedPhase = label;
          writeLine(dependencies.stderr, `TapHound verification: ${label}`);
        }
      };
      reportPhaseProgress(status);
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
        reportPhaseProgress(status);
      }
      if (options.json === true) {
        writeJson(dependencies.stdout, {
          status: "inspected",
          exitCode: 0,
          ...status
        });
      } else {
        writeLine(dependencies.stdout, generationStatusText(status));
      }
      dependencies.setExitCode(0);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

export function createArchiveCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("archive")
      .description("Mark an idle generation session as archived"),
    dependencies
  ).action(async (options: GenerationObserveOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const session = await runtime.archive(generationId);
      writeSuccess(dependencies, options, {
        status: "archived",
        exitCode: 0,
        generationId,
        revision: session.revision
      }, `Generation ${generationId} archived`);
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

export function idlePolicyText(policy: NonNullable<GenerationSession["idlePolicy"]>): string {
  return `strategy ${policy.strategy}, poll ${String(policy.pollIntervalMs)}ms x${
    String(policy.stablePolls)
  }, timeout ${String(policy.timeoutMs)}ms`;
}

export function createConfigCommand(dependencies: CliDependencies): Command {
  return new Command("config")
    .description("Adjust session-scoped generation settings")
    .addCommand(addCommonOptions(
      new Command("idle")
        .description(
          "Hot-adjust the idle policy bound to a generation session"
        )
        .option(
          "--strategy <strategy>",
          "Idle strategy: hybrid, layoutDiff, frameStats, or structural"
        )
        .option(
          "--poll-interval-ms <milliseconds>",
          "Idle poll interval in milliseconds"
        )
        .option(
          "--stable-polls <count>",
          "Consecutive stable polls required before idle"
        )
        .option(
          "--timeout-ms <milliseconds>",
          "Idle timeout in milliseconds"
        ),
      dependencies
    ).action(async (options: GenerationConfigIdleOptions): Promise<void> => {
      try {
        const generationId = GenerationSessionIdSchema.parse(options.session);
        const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
        const runtime = requireRuntime(dependencies, projectRoot, config);
        await assertRuntimeConfig(runtime, generationId);
        const strategy = options.strategy === undefined
          ? undefined
          : z
            .enum(["hybrid", "layoutDiff", "frameStats", "structural"])
            .parse(options.strategy);
        const pollIntervalMs = options.pollIntervalMs === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(options.pollIntervalMs);
        const stablePolls = options.stablePolls === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(options.stablePolls);
        const timeoutMs = options.timeoutMs === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(options.timeoutMs);
        if (
          strategy === undefined
          && pollIntervalMs === undefined
          && stablePolls === undefined
          && timeoutMs === undefined
        ) {
          throw new GenerationOperationError(
            "CONFIG_INVALID",
            "Generation idle policy update requires at least one setting"
          );
        }
        const session = await runtime.updateIdlePolicy(generationId, {
          ...(strategy === undefined ? {} : { strategy }),
          ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
          ...(stablePolls === undefined ? {} : { stablePolls }),
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        });
        const policy = session.idlePolicy;
        writeSuccess(dependencies, options, {
          status: "updated",
          exitCode: 0,
          generationId,
          revision: session.revision,
          ...(policy === undefined ? {} : { idlePolicy: policy })
        }, policy === undefined
          ? `Generation idle policy updated (revision ${String(session.revision)})`
          : `Generation idle policy updated (revision ${String(session.revision)}): ${idlePolicyText(policy)}`);
      } catch (error) {
        mappedFailure(dependencies, options, error);
      }
    }));
}

export function generationListText(sessions: readonly GenerationSession[]): string {
  if (sessions.length === 0) {
    return "No generation sessions found.";
  }
  const lines = sessions.map((session) => {
    const verification = session.verification.status;
    const publication = session.publication.status;
    const steps = String(session.candidateSteps.length);
    return `  ${session.id}  ${session.state.padEnd(14)} revision ${String(session.revision).padStart(3)}  steps ${steps.padStart(3)}  verification ${verification}  publication ${publication}`;
  });
  return `Generation sessions (${String(sessions.length)}):\n${lines.join("\n")}`;
}

export function createListCommand(dependencies: CliDependencies): Command {
  return new Command("list")
    .description("List generation sessions in the project workspace")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: GenerationListOptions): Promise<void> => {
      try {
        const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
        const runtime = requireRuntime(
          dependencies,
          projectRoot,
          config
        );
        const sessions = await runtime.list();
        if (options.json === true) {
          writeJson(dependencies.stdout, {
            status: "listed",
            exitCode: 0,
            sessions
          });
        } else {
          writeLine(dependencies.stdout, generationListText(sessions));
        }
        dependencies.setExitCode(0);
      } catch (error) {
        mappedFailure(dependencies, options, error);
      }
    });
}
