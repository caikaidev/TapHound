import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TapHoundConfigSchema } from "../../src/domain/config.js";
import { JourneySchema } from "../../src/domain/journey.js";
import { AcceptanceContractSchema } from "../../src/domain/contract.js";
import { hashJourney } from "../../src/domain/report.js";

const root = join(process.cwd(), "examples", "taphound-android-demo");

async function text(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await text(relativePath)) as unknown;
}

describe("TapHound Android acceptance fixture", () => {
  it("binds the P4 event Capture Journey to existing demo source without modifying benchmarks", async () => {
    const journey = JourneySchema.parse(
      await json(".taphound/journeys/acceptance-binding.json")
    );
    const search = await text("app/src/main/java/dev/taphound/demo/SearchActivity.kt");
    expect(search).toContain('.put("fields", JSONObject().put("query", query))');
    expect(journey.steps[4]?.expect).toMatchObject({
      type: "logcatEvent",
      capture: { name: "query", field: "query", valueType: "string" }
    });
    expect(journey.steps[5]).toMatchObject({
      action: "inputText", text: "${query}"
    });
    expect(journey.steps[6]?.expect).toMatchObject({
      type: "logcatEvent",
      correlation: { key: "query", value: "${query}" },
      window: { from: "marker", markerId: "binding-start" }
    });
  });

  it("binds the structured event and required Checkpoint to source-backed demo behavior", async () => {
    const journey = JourneySchema.parse(
      await json(".taphound/journeys/acceptance-event.json")
    );
    const contract = AcceptanceContractSchema.parse(
      await json(".taphound/contracts/acceptance-event.json")
    );
    const search = await text(
      "app/src/main/java/dev/taphound/demo/SearchActivity.kt"
    );
    expect(search).toContain('Log.i(\n                "SearchEvent"');
    expect(search).toContain('.put("event", "resultsReady")');
    expect(search).toContain('.put("fields", JSONObject().put("query", query))');
    expect(journey.steps[1]).toMatchObject({
      action: "wait", markerId: "search-start"
    });
    expect(journey.steps[4]?.expect).toMatchObject({
      type: "logcatEvent", tag: "SearchEvent", event: "resultsReady",
      fields: { query: "hello world" }, window: { from: "stepStart" }
    });
    expect(journey.checkpoints?.[0]?.expect.allOf).toMatchObject([
      { kind: "visibleElement" }, { kind: "absentElement" }, {
        kind: "logcatEvent", expect: {
          window: { from: "marker", markerId: "search-start" }
        }
      }
    ]);
    expect(contract.journey.sha256).toBe(hashJourney(journey));
    expect(contract.requiredCheckpoints).toEqual(["search-event-ready"]);
  });

  it("includes a pinned, executable Gradle Wrapper", async () => {
    const wrapperScript = join(root, "gradlew");
    const wrapperProperties = await text(
      "gradle/wrapper/gradle-wrapper.properties"
    );
    const wrapperJar = await readFile(
      join(root, "gradle", "wrapper", "gradle-wrapper.jar")
    );

    await expect(access(wrapperScript, constants.X_OK)).resolves.toBeUndefined();
    expect(wrapperProperties).toContain("gradle-9.1.0-bin.zip");
    expect(wrapperProperties).toContain(
      "distributionSha256Sum=a17ddd85a26b6a7f5ddb71ff8b05fc5104c0202c6e64782429790c933686c806"
    );
    expect(createHash("sha256").update(wrapperJar).digest("hex"))
      .toBe("76805e32c009c0cf0dd5d206bddc9fb22ea42e84db904b764f3047de095493f3");
  });

  it("keeps Package and Activity identities aligned", async () => {
    const config = TapHoundConfigSchema.parse(
      await json(".taphound/config.json")
    );
    const journey = JourneySchema.parse(await json(".taphound/journeys/search.json"));
    const manifest = await text("app/src/main/AndroidManifest.xml");
    const main = await text(
      "app/src/main/java/dev/taphound/demo/MainActivity.kt"
    );
    const search = await text(
      "app/src/main/java/dev/taphound/demo/SearchActivity.kt"
    );
    const appBuild = await text("app/build.gradle.kts");

    expect(config.run).toEqual({
      packageName: "dev.taphound.demo",
      activity: ".MainActivity"
    });
    expect(appBuild).toContain('namespace = "dev.taphound.demo"');
    expect(appBuild).toContain('applicationId = "dev.taphound.demo"');
    expect(manifest).toContain('android:name=".MainActivity"');
    expect(manifest).toContain('android:name=".SearchActivity"');
    expect(main).toContain("package dev.taphound.demo");
    expect(search).toContain("package dev.taphound.demo");
    expect(journey.steps[0]?.activity).toEqual({
      before: "dev.taphound.demo.MainActivity",
      after: "dev.taphound.demo.SearchActivity"
    });
    expect(journey.steps.every((step) => (
      step.activity.before.startsWith("dev.taphound.demo.")
      && step.activity.after.startsWith("dev.taphound.demo.")
    ))).toBe(true);
  });

  it("keeps Journey Locators synchronized with Android resources", async () => {
    const journey = JourneySchema.parse(await json(".taphound/journeys/search.json"));
    const mainLayout = await text("app/src/main/res/layout/activity_main.xml");
    const searchLayout = await text("app/src/main/res/layout/activity_search.xml");

    const resourceIds = journey.steps.flatMap((step) => {
      if ("locator" in step && step.locator?.resourceId !== undefined) {
        return [step.locator.resourceId];
      }
      if (
        step.expect?.type === "element"
        && step.expect.locator.resourceId !== undefined
      ) {
        return [step.expect.locator.resourceId];
      }
      return [];
    });
    for (const resourceId of resourceIds) {
      expect(`${mainLayout}\n${searchLayout}`)
        .toContain(`android:id="@+id/${resourceId}"`);
    }
    expect(resourceIds).toEqual(expect.arrayContaining([
      "open_search",
      "search_input",
      "submit_search"
    ]));
  });

  it("matches submission evidence to the demo behavior", async () => {
    const benchmark = JourneySchema.parse(await json(".taphound/journeys/search.json"));
    const journey = JourneySchema.parse(
      await json(".taphound/journeys/acceptance-search.json")
    );
    const search = await text(
      "app/src/main/java/dev/taphound/demo/SearchActivity.kt"
    );
    expect(benchmark.steps[3]?.expect).toMatchObject({
      type: "logcat",
      tag: "SearchViewModel",
      level: "I",
      pattern: "submitted query=hello world"
    });
    expect(journey.steps.slice(0, 3)).toEqual(benchmark.steps.slice(0, 3));
    expect(journey.steps[3]).toMatchObject({
      action: "click",
      locator: { resourceId: "submit_search" },
      activity: benchmark.steps[3]?.activity
    });
    expect(journey.steps[3]?.expect).toMatchObject({
      type: "element",
      locator: { contentDescription: "submitted query=hello world" }
    });
    expect(search).toContain('result.contentDescription = "submitted query=$query"');
    expect(search).toContain('Log.i("SearchViewModel", "submitted query=$query")');
    const generation = await readFile(
      join(process.cwd(), "scripts", "acceptance-generation.mjs"),
      "utf8"
    );
    expect(generation).toContain(
      'locator: { contentDescription: "submitted query=hello world" }'
    );
  });

  it("requires explicit opt-in before the device acceptance runner invokes TapHound", async () => {
    const runner = await readFile(
      join(process.cwd(), "scripts", "acceptance-device.mjs"),
      "utf8"
    );
    const packageDocument: unknown = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8")
    );
    const scripts = packageDocument !== null && typeof packageDocument === "object"
      ? (packageDocument as { scripts?: Record<string, string> }).scripts
      : undefined;

    expect(runner).toContain("TAPHOUND_ACCEPTANCE_DEVICE");
    expect(runner).toContain('"dist", "cli", "main.js"');
    expect(runner).toContain("verify");
    expect(runner).toContain('"acceptance-search.json"');
    expect(runner).toContain("--json");
    expect(scripts?.["acceptance:device"])
      .toBe("node scripts/acceptance-device.mjs");
  });

  it("keeps generation acceptance aligned with strict command contracts", async () => {
    const runner = await readFile(
      join(process.cwd(), "scripts", "acceptance-generation.mjs"),
      "utf8"
    );
    const startCommand = runner.match(
      /const startOutput = runCli\(\[([\s\S]*?)\]\);/
    )?.[1];
    const observeCommand = runner.match(
      /let observation = runCli\(\[([\s\S]*?)\]\);/
    )?.[1];
    const finalizeCommand = runner.match(
      /const finalizeOutput = runCli\(\[([\s\S]*?)\]\);/
    )?.[1];

    expect(runner).toContain("TAPHOUND_ACCEPTANCE_DEVICE");
    expect(runner).toContain("version: 2");
    expect(runner).toContain("moduleContext");
    expect(runner).toContain("pathSetSha256");
    expect(runner).not.toMatch(/\bafter\s*:/);
    expect(startCommand).toContain('"generation", "start"');
    expect(startCommand).toContain("...deviceArgs");
    expect(observeCommand).toContain('"generation", "observe"');
    expect(observeCommand).not.toContain("...deviceArgs");
    expect(finalizeCommand).toContain('"generation", "finalize"');
    expect(finalizeCommand).toContain("...deviceArgs");
  });
});
