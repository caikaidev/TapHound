import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { UiCaptureTelemetry } from "../../src/application/diagnostics/ui-capture-telemetry.js";
import {
  commandEvent,
  describeInvocation,
  diagnosticsEnabled,
  outcomeFromJsonOutput
} from "../../src/cli/diagnostics-recorder.js";

describe("diagnostics recorder", () => {
  it("names the command path and only the flags the user passed", async () => {
    let described: ReturnType<typeof describeInvocation> | undefined;
    const program = new Command("taphound").exitOverride();
    program.addCommand(new Command("generation").addCommand(
      new Command("step")
        .option("--project <path>", "root", "/cwd")
        .option("--input <path>")
        .option("--json")
        .action(() => undefined)
    ));
    program.hook("preAction", (_program, action) => {
      described = describeInvocation(action, "/cwd");
    });

    await program.parseAsync([
      "node", "taphound", "generation", "step", "--input", "/secret/envelope.json", "--json"
    ]);

    expect(described).toEqual({
      command: "generation step",
      flags: ["input", "json"],
      projectRoot: "/cwd"
    });
  });

  it("reads only status, failure code, and run id from JSON output", () => {
    expect(outcomeFromJsonOutput(JSON.stringify({
      status: "failed",
      exitCode: 1,
      report: {
        runId: "2026-09-28T12-00-00.000Z-abc",
        primaryFailure: { code: "LOCATOR_NOT_FOUND", message: "text=Secret" }
      }
    }))).toEqual({
      status: "failed",
      failureCode: "LOCATOR_NOT_FOUND",
      runId: "2026-09-28T12-00-00.000Z-abc"
    });
    expect(outcomeFromJsonOutput(JSON.stringify({
      exitCode: 2,
      failure: { code: "CONFIG_INVALID", message: "/Users/secret/project" }
    }))).toEqual({ failureCode: "CONFIG_INVALID" });
    expect(outcomeFromJsonOutput(JSON.stringify({
      status: "error",
      exitCode: 1,
      failure: {
        code: "ACTION_UNSUPPORTED",
        message: "Layout target lacks required clickable capability"
      }
    }))).toEqual({ status: "error", failureCode: "ACTION_UNSUPPORTED" });
    expect(outcomeFromJsonOutput(JSON.stringify({
      failure: { code: "NOT_A_TAPHOUND_CODE" }
    }))).toEqual({});
    expect(outcomeFromJsonOutput(JSON.stringify({ verdict: "inconclusive" })))
      .toEqual({ status: "inconclusive" });
    expect(outcomeFromJsonOutput(JSON.stringify({ status: "com.secret.app/Main" }))).toEqual({});
    expect(outcomeFromJsonOutput("TapHound verify: PASSED")).toEqual({});
  });

  it("builds a schema-valid event and honors the opt-out", () => {
    const event = commandEvent({
      invocation: { command: "verify", flags: ["json"], projectRoot: "/p" },
      startedAt: new Date("2026-09-28T12:00:00.000Z"),
      durationMs: 12.6,
      exitCode: 0,
      stdout: undefined,
      telemetry: new UiCaptureTelemetry()
    });

    expect(event).toMatchObject({ command: "verify", durationMs: 13, exitCode: 0, ui: [] });
    expect(event).not.toHaveProperty("status");
    expect(diagnosticsEnabled({})).toBe(true);
    expect(diagnosticsEnabled({ TAPHOUND_DIAGNOSTICS: "off" })).toBe(false);
    expect(diagnosticsEnabled({ TAPHOUND_DIAGNOSTICS: "0" })).toBe(false);
  });
});
