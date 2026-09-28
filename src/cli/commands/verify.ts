import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { Command } from "commander";

import { readCliVersion } from "../version.js";
import { runDiffVerification } from "../diff-verification.js";
import {
  loadPublishedReplayPolicy,
  type PublishedReplayPolicy
} from "../../application/generation/replay-policy-loader.js";
import { logcatEvidenceWarning } from "../../application/report/report-writer.js";
import { TapHoundConfigSchema } from "../../domain/config.js";
import {
  DEFAULT_DEVICE_ROLE,
  JourneySchema
} from "../../domain/journey.js";
import {
  assertArtifactDirectory,
  CONFIG_PATH
} from "../../domain/workspace.js";
import {
  exitCodeForFailure,
  type FailureCode
} from "../../domain/failure.js";
import {
  VERIFY_RECEIPT_FILE,
  VerifyReceiptSchema
} from "../../domain/verify-receipt.js";
import type { CliDependencies } from "../dependencies.js";
import {
  errorMessage,
  failureOutput,
  writeJson,
  writeLine
} from "../output.js";
import { prepareWorkspace } from "../workspace-guard.js";

interface VerifyOptions {
  project: string;
  config: string;
  journey?: string | undefined;
  contract?: string | undefined;
  diff?: string | undefined;
  base?: string | undefined;
  head?: string | undefined;
  scope?: string | undefined;
  device?: string | undefined;
  package?: string | undefined;
  activity?: string | undefined;
  reports?: string | undefined;
  policyFromMeta?: boolean | undefined;
  json?: boolean | undefined;
}

function toolVersions(checks: Awaited<ReturnType<CliDependencies["doctor"]["run"]>>["checks"]): Record<string, string> {
  return Object.fromEntries(checks.flatMap((check) => (
    check.version === undefined
      || !["node", "adb", "android"].includes(check.name)
      ? []
      : [[check.name, check.version]]
  )));
}

function writeFailure(
  dependencies: CliDependencies,
  json: boolean,
  code: FailureCode,
  message: string
): void {
  const exitCode = exitCodeForFailure(code);
  const output = failureOutput(exitCode, code, message);
  if (json) {
    writeJson(dependencies.stdout, output);
  } else {
    writeLine(dependencies.stderr, output.failure.message);
  }
  dependencies.setExitCode(exitCode);
}

/** The normalized invocation TapHound ran, recorded in the process receipt. */
function receiptArgv(
  options: VerifyOptions,
  projectRoot: string,
  deviceSerial: string
): string[] {
  const root = resolve(projectRoot);
  return [
    "verify",
    "--project", root,
    "--config", resolve(root, options.config),
    "--journey", resolve(root, options.journey as string),
    "--device", deviceSerial,
    ...(options.package === undefined ? [] : ["--package", options.package]),
    ...(options.activity === undefined ? [] : ["--activity", options.activity]),
    ...(options.reports === undefined ? [] : ["--reports", options.reports]),
    ...(options.policyFromMeta === true ? ["--policy-from-meta"] : []),
    ...(options.json === true ? ["--json"] : [])
  ];
}

/**
 * Publishes the process receipt beside the report. The report is already
 * published, so a receipt failure is reported on stderr and leaves the
 * verify result intact; a Workflow checker then pauses on the missing receipt.
 */
async function writeReceipt(
  dependencies: CliDependencies,
  argv: string[],
  result: { exitCode: number; reportPath: string; report: { journey: { sha256: string } } }
): Promise<string | undefined> {
  if (dependencies.writeVerifyReceipt === undefined) return undefined;
  const receiptPath = join(dirname(result.reportPath), VERIFY_RECEIPT_FILE);
  try {
    const receipt = VerifyReceiptSchema.parse({
      version: 1,
      argv,
      exitCode: result.exitCode,
      journeySha256: result.report.journey.sha256,
      reportPath: result.reportPath,
      reportSha256: createHash("sha256")
        .update(await dependencies.readFile(result.reportPath))
        .digest("hex")
    });
    await dependencies.writeVerifyReceipt(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    return receiptPath;
  } catch (error) {
    writeLine(
      dependencies.stderr,
      `TapHound: verify receipt was not written: ${errorMessage(error)}`
    );
    return undefined;
  }
}

async function runDoctorAndVerify(
  dependencies: CliDependencies,
  options: VerifyOptions,
  config: ReturnType<typeof TapHoundConfigSchema.parse>,
  journey: ReturnType<typeof JourneySchema.parse>,
  projectRoot: string
): Promise<void> {
  const json = options.json === true;
  let replayPolicy: PublishedReplayPolicy | undefined;
  if (options.policyFromMeta === true) {
    try {
      const journeyPath = resolve(projectRoot, options.journey as string);
      replayPolicy = await loadPublishedReplayPolicy({
        readJson: dependencies.readJson,
        projectRoot,
        journeyPath,
        journey
      });
    } catch (error) {
      writeFailure(dependencies, json, "REPLAY_POLICY_UNAVAILABLE", errorMessage(error));
      return;
    }
  }
  try {
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
      const output = failureOutput(
        3,
        doctor.failureCode ?? "ENVIRONMENT_MISSING_TOOL",
        doctor.checks.find((check) => check.status === "failed")?.message
          ?? "TapHound environment preflight failed"
      );
      if (json) {
        writeJson(dependencies.stdout, output);
      } else {
        writeLine(dependencies.stderr, output.failure.message);
      }
      dependencies.setExitCode(3);
      return;
    }
    const deviceSerial = options.device ?? doctor.deviceSerial;
    if (deviceSerial === undefined) {
      throw new Error("Doctor did not select a device");
    }
    if (journey.devices.length > 1) {
      const output = failureOutput(
        3,
        "DEVICE_ROLE_UNMAPPED",
        `Journey declares multiple devices; map each role with --device <role>=<serial> for: ${journey.devices.map((device) => device.role).join(", ")}`
      );
      if (json) {
        writeJson(dependencies.stdout, output);
      } else {
        writeLine(dependencies.stderr, output.failure.message);
      }
      dependencies.setExitCode(3);
      return;
    }
    writeLine(dependencies.stderr, `TapHound: verifying ${journey.name}`);
    const result = await dependencies.verifier.verify({
      config: replayPolicy === undefined ? config : { ...config, idle: replayPolicy.idle },
      journey,
      projectRoot,
      devices: [{
        role: journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE,
        deviceSerial
      }],
      toolVersions: toolVersions(doctor.checks),
      manualReplay: process.stdin.isTTY,
      ...(replayPolicy === undefined ? {} : {
        generatedReplayPolicy: replayPolicy.generatedReplayPolicy,
        requireFocusedInput: replayPolicy.requireFocusedInput
      }),
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal })
    });
    const receiptPath = await writeReceipt(
      dependencies,
      receiptArgv(options, projectRoot, deviceSerial),
      result
    );
    if (json) {
      writeJson(
        dependencies.stdout,
        receiptPath === undefined ? result : { ...result, receiptPath }
      );
    } else {
      writeLine(
        dependencies.stdout,
        `TapHound verify: ${result.status.toUpperCase()}\nReport: ${result.reportPath}${
          receiptPath === undefined ? "" : `\nReceipt: ${receiptPath}`
        }`
      );
    }
    const logcatWarning = logcatEvidenceWarning(result.report);
    if (logcatWarning !== undefined) {
      writeLine(dependencies.stderr, logcatWarning);
    }
    dependencies.setExitCode(result.exitCode);
  } catch (error) {
    const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
    if (json) {
      writeJson(dependencies.stdout, output);
    } else {
      writeLine(dependencies.stderr, output.failure.message);
    }
    dependencies.setExitCode(4);
  }
}

async function runContractVerify(
  dependencies: CliDependencies,
  options: VerifyOptions,
  config: ReturnType<typeof TapHoundConfigSchema.parse>,
  projectRoot: string
): Promise<void> {
  const json = options.json === true;
  if (dependencies.contractVerifier === undefined) {
    writeFailure(
      dependencies,
      json,
      "CONFIG_INVALID",
      "TapHound contract verification is not configured"
    );
    return;
  }
  let replayPolicy: PublishedReplayPolicy | undefined;
  if (options.policyFromMeta === true) {
    try {
      if (dependencies.contractLoader === undefined) {
        throw new Error("Contract loader is not configured");
      }
      const loaded = await dependencies.contractLoader.load({
        projectRoot,
        contractPath: resolve(projectRoot, options.contract as string)
      });
      replayPolicy = await loadPublishedReplayPolicy({
        readJson: dependencies.readJson,
        projectRoot,
        journeyPath: loaded.journeyPath,
        journey: loaded.journey
      });
    } catch (error) {
      writeFailure(dependencies, json, "REPLAY_POLICY_UNAVAILABLE", errorMessage(error));
      return;
    }
  }
  try {
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
        json,
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
    writeLine(
      dependencies.stderr,
      `TapHound: verifying contract ${resolve(projectRoot, options.contract as string)}`
    );
    const result = await dependencies.contractVerifier.verify({
      projectRoot,
      config: replayPolicy === undefined ? config : { ...config, idle: replayPolicy.idle },
      devices: [{
        role: DEFAULT_DEVICE_ROLE,
        deviceSerial
      }],
      toolVersions: toolVersions(doctor.checks),
      taphoundVersion: readCliVersion(),
      contractPath: resolve(projectRoot, options.contract as string),
      manualReplay: process.stdin.isTTY,
      ...(replayPolicy === undefined ? {} : {
        generatedReplayPolicy: replayPolicy.generatedReplayPolicy,
        requireFocusedInput: replayPolicy.requireFocusedInput
      }),
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal })
    });
    if (json) {
      writeJson(dependencies.stdout, result.view);
    } else {
      writeLine(
        dependencies.stdout,
        `TapHound verify --contract: ${result.view.verdict.toUpperCase()}\nReport: ${result.view.reportPath ?? "n/a"}`
      );
    }
    dependencies.setExitCode(result.exitCode);
  } catch (error) {
    const output = failureOutput(4, "INTERNAL_ERROR", errorMessage(error));
    if (json) {
      writeJson(dependencies.stdout, output);
    } else {
      writeLine(dependencies.stderr, output.failure.message);
    }
    dependencies.setExitCode(4);
  }
}

export function createVerifyCommand(dependencies: CliDependencies): Command {
  return new Command("verify")
    .description("Deterministically verify a TapHound Journey or Acceptance Contract")
    .option("--project <path>", "Android project root", dependencies.cwd())
    .option("--config <path>", "TapHound config path", CONFIG_PATH)
    .option("--journey <path>", "TapHound Journey path")
    .option("--contract <path>", "Acceptance Contract path (mutually exclusive with --journey)")
    .option("--diff <ref>", "Verify the Journeys a Git change affects (diff mode)")
    .option("--base <ref>", "Base Git ref for --diff (default origin/main)")
    .option("--head <ref>", "Head Git ref for --diff (HEAD by default, or WORKTREE)")
    .option("--scope <p0,p1,p2>", "Selection tiers for --diff", "p0,p1")
    .option("--device <serial>", "Select an online Android device")
    .option("--package <name>", "Override run.packageName")
    .option("--activity <name>", "Override run.activity")
    .option("--reports <path>", "Report output under .taphound/build")
    .option("--policy-from-meta", "Require the bound strict Generation Replay policy")
    .option("--json", "Emit one machine-readable JSON value")
    .action(async (options: VerifyOptions): Promise<void> => {
      if (options.policyFromMeta === true && options.diff !== undefined) {
        writeFailure(
          dependencies,
          options.json === true,
          "CONFIG_INVALID",
          "--policy-from-meta supports --journey or --contract, not --diff"
        );
        return;
      }
      if (options.diff !== undefined) {
        await runDiffVerification(dependencies, {
          project: options.project,
          config: options.config,
          base: options.base ?? options.diff,
          ...(options.head === undefined ? {} : { head: options.head }),
          ...(options.device === undefined ? {} : { device: options.device }),
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          json: options.json === true
        });
        return;
      }
      if (options.journey === undefined && options.contract === undefined) {
        writeFailure(
          dependencies,
          options.json === true,
          "CONFIG_INVALID",
          "verify requires exactly one of --journey or --contract"
        );
        return;
      }
      if (options.journey !== undefined && options.contract !== undefined) {
        writeFailure(
          dependencies,
          options.json === true,
          "CONFIG_INVALID",
          "--journey and --contract are mutually exclusive"
        );
        return;
      }
      let config;
      if (options.contract === undefined) {
        let journey;
        try {
          const rawConfig = await dependencies.readJson(
            resolve(options.project, options.config)
          );
          const parsed = TapHoundConfigSchema.parse(rawConfig);
          config = TapHoundConfigSchema.parse({
            ...parsed,
            run: {
              packageName: options.package ?? parsed.run.packageName,
              activity: options.activity ?? parsed.run.activity
            },
            artifactsDir: options.reports ?? parsed.artifactsDir
          });
          assertArtifactDirectory(options.project, config.artifactsDir);
          await prepareWorkspace(dependencies, options.project);
          journey = JourneySchema.parse(await dependencies.readJson(
            resolve(options.project, options.journey as string)
          ));
        } catch (error) {
          const output = failureOutput(2, "CONFIG_INVALID", errorMessage(error));
          if (options.json === true) {
            writeJson(dependencies.stdout, output);
          } else {
            writeLine(dependencies.stderr, output.failure.message);
          }
          dependencies.setExitCode(2);
          return;
        }

        await runDoctorAndVerify(
          dependencies,
          options,
          config,
          journey,
          options.project
        );
        return;
      }

      let contractConfig;
      try {
        const rawConfig = await dependencies.readJson(
          resolve(options.project, options.config)
        );
        const parsed = TapHoundConfigSchema.parse(rawConfig);
        contractConfig = TapHoundConfigSchema.parse({
          ...parsed,
          run: {
            packageName: options.package ?? parsed.run.packageName,
            activity: options.activity ?? parsed.run.activity
          },
          artifactsDir: options.reports ?? parsed.artifactsDir
        });
        assertArtifactDirectory(options.project, contractConfig.artifactsDir);
        await prepareWorkspace(dependencies, options.project);
      } catch (error) {
        const output = failureOutput(2, "CONFIG_INVALID", errorMessage(error));
        if (options.json === true) {
          writeJson(dependencies.stdout, output);
        } else {
          writeLine(dependencies.stderr, output.failure.message);
        }
        dependencies.setExitCode(2);
        return;
      }
      await runContractVerify(
        dependencies,
        options,
        contractConfig,
        options.project
      );
    });
}