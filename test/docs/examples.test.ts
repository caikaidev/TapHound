import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";
import { JourneySchema } from "../../src/domain/journey.js";

const root = process.cwd();

async function text(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await text(relativePath)) as unknown;
}

describe("TapHound documentation examples", () => {
  it("keeps standalone config and Journey examples schema-valid", async () => {
    const config = TapHoundConfigSchema.parse(await json("examples/taphound.config.json"));
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
    expect(readme).toContain("# TapHound");
    expect(readme).toContain("TapHound for Android");
    expect(readme).toContain("Follow every tap. Catch every regression.");
    expect(readme).toContain("TapHound Journey");
    expect(readme).toContain("Android CLI 官方 Journey");
    expect(readme).not.toMatch(/\bAPR\b|\bapr\b/);
    for (const command of commandNames) {
      expect(readme).toContain(`taphound ${command}`);
    }
    expect(readme).toContain("Node.js 22");
    expect(readme).toContain("macOS");
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
    expect(agent).toContain("taphound verify");
    expect(agent).not.toMatch(/\bAPR\b|\bapr\b/);
    expect(agent).toContain("--json");
    expect(agent).toContain("stdout");
    expect(agent).toContain("stderr");
    expect(agent).toContain("exitCode");
    expect(agent).toContain("Skill");
    expect(agent).toContain("SubAgent");
    expect(agent).toContain("不在 v0.2");
  });

  it("brands active schema documentation as TapHound", async () => {
    const journey = await text("docs/journey-schema.md");
    const report = await text("docs/report-schema.md");

    expect(journey).toContain("TapHound Journey");
    expect(journey).toContain("taphound.config.json");
    expect(journey).not.toMatch(/\bAPR\b|\bapr\b/);
    expect(report).toContain("TapHound Report");
    expect(report).toContain(".taphound/runs");
    expect(report).not.toMatch(/\bAPR\b|\bapr\b/);
  });

  it("keeps verification evidence pointed at the runnable Android demo", async () => {
    const audit = await text("docs/verification/taphound-v0.2-audit.md");

    expect(audit).toContain("examples/taphound-android-demo");
    expect(audit).not.toContain("examples/taphound-demo");
  });

  it("keeps local testing and machine handoff instructions discoverable", async () => {
    const readme = await text("README.md");
    const testing = await text("docs/local-testing.md");
    const todo = await text("TODO.md");

    expect(readme).toContain("docs/local-testing.md");
    expect(readme).toContain("TODO.md");
    expect(testing).toContain("npm test");
    expect(testing).toContain("npm run acceptance:device");
    expect(testing).toContain("taphound-0.2.0-dev.1.tgz");
    expect(testing).toContain("examples/taphound-android-demo");
    expect(todo).toContain("换机后");
    expect(todo).toContain("npm `dev` 预发布");
  });

  it("ignores generated Node, TapHound, Android, and local environment files", async () => {
    const ignore = await text(".gitignore");

    for (const pattern of [
      "node_modules/",
      "dist/",
      "coverage/",
      ".taphound/",
      ".gradle/",
      "**/build/",
      "local.properties",
      ".env"
    ]) {
      expect(ignore).toContain(pattern);
    }
  });
});
