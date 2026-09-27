// `generation` subcommands that bind and execute steps: step, confirm, manual, and bridge.

import { resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";

import {
  GenerationOperationError
} from "../../../application/generation/generation-starter.js";
import {
  GenerationSessionIdSchema
} from "../../../domain/generation.js";
import {
  BridgeScenarioSchema,
  type BridgeScenario
} from "../../../domain/journey.js";
import { LocatorSchema } from "../../../domain/layout.js";
import type { CliDependencies } from "../../dependencies.js";
import {
  type GenerationBridgeOptions,
  type GenerationConfirmOptions,
  type GenerationManualOptions,
  type GenerationStepOptions,
  ManualActionSchema,
  PlannerEnvelopeSchema,
  addCommonOptions,
  assertRuntimeConfig,
  executeApproved,
  generationConfig,
  mappedFailure,
  requireRuntime,
  tools,
  writeFailure,
  writeSuccess
} from "./shared.js";

export function createStepCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("step")
      .description("Accept and execute one strict planner proposal")
      .option(
        "--compact",
        "Return authoritative nextSnapshotRef instead of the full next snapshot"
      )
      .option("--input <path>", "Strict proposal envelope path")
      .option(
        "--replace <index>",
        "Truncate candidate steps at <index>, replay the stored prefix, and bind a fresh snapshot"
      ),
    dependencies
  ).action(async (options: GenerationStepOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      if (options.replace !== undefined) {
        if (options.input !== undefined) {
          throw new GenerationOperationError(
            "CONFIG_INVALID",
            "generation step accepts either --input or --replace, not both"
          );
        }
        const stepIndex = z.coerce.number().int().nonnegative().parse(
          options.replace
        );
        const session = await runtime.readSession(generationId);
        const doctor = await dependencies.doctor.run({
          packageName: config.run.packageName,
          skipPermissionProbe: true,
          requestedDevice: session.target.deviceSerial,
          ...(config.ui?.backend === undefined
            ? {}
            : { requestedUiBackend: config.ui.backend }),
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
        const result = await runtime.replace({
          generationId,
          stepIndex,
          projectRoot: projectRoot,
          config,
          toolVersions: tools(doctor.checks),
          manualReplay: process.stdin.isTTY,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal })
        });
        writeSuccess(dependencies, options, {
          status: "replaced",
          exitCode: 0,
          stepIndex: result.stepIndex,
          remainingStepCount: result.remainingStepCount,
          truncatedStepCount: result.truncatedStepCount,
          ...result.observation.binding,
          snapshotRef: result.observation.snapshotRef,
          ...(options.compact === true
            ? {}
            : { snapshot: result.observation.snapshot })
        }, `Generation truncated to ${
          String(result.remainingStepCount)
        } step(s) at index ${String(result.stepIndex)} and re-observed`);
        return;
      }
      if (options.input === undefined) {
        throw new GenerationOperationError(
          "CONFIG_INVALID",
          "generation step requires either --input <envelope> or --replace <index>"
        );
      }
      const envelope: z.infer<typeof PlannerEnvelopeSchema> = PlannerEnvelopeSchema.parse(
        await dependencies.readJson(resolve(projectRoot, options.input))
      );
      const confirmation = await runtime.confirmation.request({
        generationId,
        proposal: envelope.proposal,
        ...("snapshot" in envelope
          ? { snapshot: envelope.snapshot }
          : { snapshotRef: envelope.snapshotRef }),
        source: "planner"
      });
      if (confirmation.status === "confirmationRequired") {
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: confirmation.revision,
          challenge: confirmation.challenge
        }, `Confirmation required: ${confirmation.challenge.challengeId}`);
        return;
      }
      await executeApproved(dependencies, options, runtime, {
        generationId,
        proposal: confirmation.proposal,
        snapshot: confirmation.snapshot,
        source: "planner"
      });
    } catch (error) {
      mappedFailure(dependencies, options, error);
    }
  });
}

export function createConfirmCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("confirm")
      .description("Approve and execute Core-owned challenge evidence")
      .option(
        "--compact",
        "Return authoritative nextSnapshotRef instead of the full next snapshot"
      )
      .option(
        "--decision <decision>",
        "Delegated non-TTY decision after explicit human review: approve or decline"
      )
      .requiredOption("--challenge <id>", "Core confirmation challenge id"),
    dependencies
  ).action(async (options: GenerationConfirmOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const challengeId = GenerationSessionIdSchema.parse(options.challenge);
      if (
        options.decision !== undefined
        && options.decision !== "approve"
        && options.decision !== "decline"
      ) {
        throw new GenerationOperationError(
          "CONFIG_INVALID",
          "generation confirm --decision must be approve or decline"
        );
      }
      const decision = options.decision;
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const approved = await runtime.confirmation.confirmStored({
        generationId,
        challengeId,
        ...(decision === undefined ? {} : { decision }),
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      if (approved.status === "declined") {
        writeSuccess(dependencies, options, {
          status: "declined",
          exitCode: 0,
          generationId,
          challengeId
        }, `Generation confirmation declined: ${challengeId}`);
        return;
      }
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

export function createManualCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("manual")
      .description("Interactively build, execute, and record one manual Journey step")
      .option(
        "--compact",
        "Return authoritative nextSnapshotRef instead of the full next snapshot"
      )
      .requiredOption(
        "--action <action>",
        "Journey action to execute through deterministic Core controls"
      ),
    dependencies
  ).action(async (options: GenerationManualOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const action = ManualActionSchema.parse(options.action);
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const existing = await runtime.confirmation.findPendingManual({
        generationId,
        action
      });
      if (existing !== null) {
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: existing.revision,
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
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: confirmation.revision,
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

export function resolveBridgeDescription(
  scenario: BridgeScenario,
  description: string | undefined
): string {
  if (description !== undefined) {
    return z.string().trim().min(1).parse(description);
  }
  switch (scenario) {
    case "photoCapture":
      return "Capture photo via system camera";
    case "pickImage":
      return "Pick image via system picker";
    case "pickFile":
      return "Pick file via system picker";
    case "custom":
      throw new GenerationOperationError(
        "CONTEXT_INVALID",
        "Bridge scenario 'custom' requires --description"
      );
  }
}

export function createBridgeCommand(dependencies: CliDependencies): Command {
  return addCommonOptions(
    new Command("bridge")
      .description("Execute a cross-application bridge step through Core controls")
      .option(
        "--compact",
        "Return authoritative nextSnapshotRef instead of the full next snapshot"
      )
      .requiredOption(
        "--scenario <scenario>",
        "Bridge scenario: photoCapture, pickImage, pickFile, or custom"
      )
      .requiredOption(
        "--trigger-locator <json>",
        "JSON locator for the trigger element"
      )
      .option(
        "--description <text>",
        "Bridge description (required for custom scenario)"
      )
      .option(
        "--return-timeout-ms <ms>",
        "Maximum time to wait for return to the target app in milliseconds",
        "60000"
      )
      .option(
        "--flow <name>",
        "External flow name for deterministic bridge replay (requires --external-flow at session start)"
      )
      .option(
        "--escape-timeout-ms <ms>",
        "Maximum time to wait for package escape after trigger click in milliseconds"
      ),
    dependencies
  )    .action(async (options: GenerationBridgeOptions): Promise<void> => {
    try {
      const generationId = GenerationSessionIdSchema.parse(options.session);
      const scenario = BridgeScenarioSchema.parse(options.scenario);
      const triggerLocator = LocatorSchema.parse(
        JSON.parse(options.triggerLocator)
      );
      const returnTimeoutMs = z.number().int().positive().parse(
        Number(options.returnTimeoutMs)
      );
      const escapeTimeoutMs = options.escapeTimeoutMs === undefined
        ? undefined
        : z.number().int().positive().parse(Number(options.escapeTimeoutMs));
      const description = resolveBridgeDescription(
        scenario,
        options.description
      );
      const { projectRoot, config } = await generationConfig(
          dependencies,
          options
        );
      const runtime = requireRuntime(dependencies, projectRoot, config);
      await assertRuntimeConfig(runtime, generationId);
      const session = await runtime.readSession(generationId);
      if (session.pendingConfirmation?.status === "pending") {
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: session.revision,
          challenge: session.pendingConfirmation
        }, `Confirmation required: ${session.pendingConfirmation.challengeId}`);
        return;
      }
      let flowName: string | undefined;
      if (options.flow !== undefined) {
        flowName = z.string().trim().min(1).parse(options.flow);
        const binding = session.externalFlows.find(
          (entry) => entry.name === flowName
        );
        if (binding === undefined) {
          throw new GenerationOperationError(
            "EXTERNAL_FLOW_NOT_FOUND",
            `External Flow "${flowName}" is not bound to generation session ${generationId}`
          );
        }
      }
      const observation = await runtime.observer.observe({
        generationId,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal })
      });
      const proposal = {
        action: "bridge" as const,
        scenario,
        description,
        triggerLocator,
        returnTimeoutMs,
        ...(flowName === undefined ? {} : { flow: flowName }),
        ...(escapeTimeoutMs === undefined ? {} : { escapeTimeoutMs }),
        binding: observation.binding,
        activity: { before: observation.snapshot.activity }
      };
      const confirmation = await runtime.confirmation.request({
        generationId,
        proposal,
        snapshot: observation.snapshot,
        source: "manualOverride" as const
      });
      if (confirmation.status === "confirmationRequired") {
        writeSuccess(dependencies, options, {
          status: "confirmationRequired",
          exitCode: 0,
          generationId,
          revision: confirmation.revision,
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
