import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { AprConfigSchema } from "../../src/domain/config.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";
import { JourneySchema } from "../../src/domain/journey.js";

const root = process.cwd();

async function text(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await text(relativePath)) as unknown;
}

describe("APR documentation examples", () => {
  it("keeps standalone config and Journey examples schema-valid", async () => {
    const config = AprConfigSchema.parse(await json("examples/apr.config.json"));
    const journey = JourneySchema.parse(await json("examples/search.journey.json"));

    expect(config.run.packageName).toBe("com.example.app");
    expect(journey.steps[0]?.activity.before).toBe(
      "com.example.app.MainActivity"
    );
  });

  it("documents every executable command and its primary workflow", async () => {
    const readme = await text("README.md");
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual(["doctor", "record", "verify"]);
    for (const command of commandNames) {
      expect(readme).toContain(`apr ${command}`);
    }
    expect(readme).toContain("Node.js 22");
    expect(readme).toContain("macOS");
    expect(readme).toContain("APR Journey");
    expect(readme).toContain("Android CLI 官方 Journey");
    expect(readme).toContain("v0.2");
  });

  it("documents Journey checkpoints, Actions, Expects, and explicit fallback", async () => {
    const journey = await text("docs/journey-schema.md");

    for (const action of [
      "click",
      "longClick",
      "inputText",
      "swipe",
      "back",
      "wait"
    ]) {
      expect(journey).toContain(`\`${action}\``);
    }
    for (const expectation of ["activity", "element", "logcat"]) {
      expect(journey).toContain(`\`${expectation}\``);
    }
    expect(journey).toContain("activity.before");
    expect(journey).toContain("activity.after");
    expect(journey).toContain("annotatedLabel");
    expect(journey).toContain("#7");
    expect(journey).toContain("不兼容");
  });

  it("documents the complete report failure and exit-code contract", async () => {
    const report = await text("docs/report-schema.md");

    for (const code of FAILURE_CODES) {
      expect(report).toContain(`\`${code}\``);
    }
    expect(report).toContain("report.json");
    expect(report).toContain("summary.txt");
    expect(report).toContain("primaryFailure");
    expect(report).toContain("secondaryErrors");
    for (const exitCode of [0, 1, 2, 3, 4]) {
      expect(report).toContain(`\`${String(exitCode)}\``);
    }
  });

  it("documents a stable Agent CLI invocation contract", async () => {
    const agent = await text("docs/agent-integration.md");

    expect(agent).toContain("Claude Code");
    expect(agent).toContain("apr verify");
    expect(agent).toContain("--json");
    expect(agent).toContain("stdout");
    expect(agent).toContain("stderr");
    expect(agent).toContain("exitCode");
    expect(agent).toContain("Skill");
    expect(agent).toContain("SubAgent");
    expect(agent).toContain("不在 v0.2");
  });

  it("ignores generated Node, APR, Android, and local environment files", async () => {
    const ignore = await text(".gitignore");

    for (const pattern of [
      "node_modules/",
      "dist/",
      "coverage/",
      ".apr/",
      ".gradle/",
      "**/build/",
      "local.properties",
      ".env"
    ]) {
      expect(ignore).toContain(pattern);
    }
  });
});
