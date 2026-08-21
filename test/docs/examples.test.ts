import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";
import { JourneySchema } from "../../src/domain/journey.js";
import {
  FlowSchema,
  JourneySourceSchema
} from "../../src/domain/journey-composition.js";

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

  it("keeps the scrollTo example journey schema-valid", async () => {
    const journey = JourneySchema.parse(
      await json("examples/scroll-to.journey.json")
    );

    expect(journey.steps).toHaveLength(4);
    expect(journey.steps[1]?.action).toBe("scrollTo");
  });

  it("keeps reusable Flow composition examples schema-valid", async () => {
    const core = FlowSchema.parse(await json(
      "examples/composition/.taphound/flows/core/authenticated-home.json"
    ));
    const feature = FlowSchema.parse(await json(
      "examples/composition/.taphound/flows/chat/open-thread.json"
    ));
    const source = JourneySourceSchema.parse(await json(
      "examples/composition/.taphound/sources/chat/send-message.json"
    ));
    const skillFlow = FlowSchema.parse(await json(
      "assets/skills/taphound-ai-journey/templates/flow.example.json"
    ));
    const skillSource = JourneySourceSchema.parse(await json(
      "assets/skills/taphound-ai-journey/templates/journey-source.example.json"
    ));

    expect(core.includes).toEqual([]);
    expect(feature.includes).toEqual(["core/authenticated-home"]);
    expect(source.includes).toEqual(["chat/open-thread"]);
    expect(skillFlow.kind).toBe("flow");
    expect(skillSource.kind).toBe("journeySource");
  });

  it("documents every executable command and its primary workflow", async () => {
    const readme = await text("README.md");
    const readmeZh = await text("README.zh-CN.md");
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual([
      "doctor",
      "record",
      "verify",
      "project",
      "context",
      "journey",
      "generation",
      "init"
    ]);
    for (const doc of [readme, readmeZh]) {
      expect(doc).toContain("# TapHound");
      expect(doc).toContain("TapHound for Android");
      expect(doc).toContain("Follow every tap. Catch every regression.");
      expect(doc).toContain("TapHound Journey");
      expect(doc).not.toMatch(/\bAPR\b|\bapr\b/);
      for (const command of ["doctor", "record", "verify"]) {
        expect(doc).toContain(`taphound ${command}`);
      }
      for (const workflow of [
        "project describe",
        "context validate",
        "journey resolve",
        "generation start",
        "taphound init"
      ]) {
        expect(doc).toContain(workflow);
      }
      expect(doc).toContain("Node.js 22");
      expect(doc).toContain("macOS");
      expect(doc).toContain("scrollTo");
      expect(doc).toContain(".taphound/journeys/");
      expect(doc).toContain(".taphound/build/");
    }
    // Chinese-specific content lives in the zh-CN README.
    expect(readmeZh).toContain("Android CLI 官方 Journey");
    expect(readmeZh).toContain("当前限制");
    // Language switcher links.
    expect(readme).toContain("README.zh-CN.md");
    expect(readmeZh).toContain("README.md");
  });

  it("documents Journey checkpoints, Actions, Expects, and explicit fallback", async () => {
    const journey = await text("docs/journey-schema.md");

    for (const action of [
      "click",
      "longClick",
      "inputText",
      "swipe",
      "scrollTo",
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
    expect(journey).toContain("does not reuse");
    expect(journey).toContain("`within`");
    expect(journey).toContain("`index`");
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
    expect(agent).toContain("Project Context");
    expect(agent).toContain("generation observe");
    expect(agent).toContain("taphound init");
  });

  it("brands active schema documentation as TapHound", async () => {
    const journey = await text("docs/journey-schema.md");
    const report = await text("docs/report-schema.md");

    expect(journey).toContain("TapHound Journey");
    expect(journey).toContain("taphound.config.json");
    expect(journey).not.toMatch(/\bAPR\b|\bapr\b/);
    expect(report).toContain("TapHound Report");
    expect(report).toContain(".taphound/build/runs");
    expect(report).not.toMatch(/\bAPR\b|\bapr\b/);
  });

  it("keeps verification evidence pointed at the runnable Android demo", async () => {
    const audit = await text("docs/verification/taphound-v0.2-audit.md");

    expect(audit).toContain("examples/taphound-android-demo");
    expect(audit).not.toContain("examples/taphound-demo");
  });

  it("keeps local testing and machine handoff instructions discoverable", async () => {
    const readme = await text("README.md");
    const readmeZh = await text("README.zh-CN.md");
    const testing = await text("docs/local-testing.md");
    const todo = await text("TODO.md");

    for (const doc of [readme, readmeZh]) {
      expect(doc).toContain("docs/local-testing.md");
      expect(doc).toContain("TODO.md");
    }
    expect(testing).toContain("npm test");
    expect(testing).toContain("npm run acceptance:device");
    expect(testing).toContain("npm run acceptance:generation");
    expect(testing).toContain("taphound-0.2.0-dev.3.tgz");
    expect(testing).toContain("examples/taphound-android-demo");
    for (const command of [
      "doctor",
      "record",
      "verify",
      "project",
      "context",
      "generation",
      "init"
    ]) {
      expect(testing).toContain(`\`${command}\``);
    }
    expect(todo).toContain("Post-Machine-Switch");
    expect(todo).toContain("npm `dev` Pre-release");
  });

  it("ignores generated Node, TapHound, Android, and local environment files", async () => {
    const ignore = await text(".gitignore");

    for (const pattern of [
      "node_modules/",
      "dist/",
      "coverage/",
      ".taphound/build/",
      ".taphound/context/",
      ".gradle/",
      "**/build/",
      "local.properties",
      ".env"
    ]) {
      expect(ignore).toContain(pattern);
    }
  });
});
