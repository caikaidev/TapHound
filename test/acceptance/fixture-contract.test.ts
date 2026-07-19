import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AprConfigSchema } from "../../src/domain/config.js";
import { JourneySchema } from "../../src/domain/journey.js";

const root = join(process.cwd(), "examples", "apr-demo");

async function text(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await text(relativePath)) as unknown;
}

describe("APR Android acceptance fixture", () => {
  it("includes a pinned, executable Gradle Wrapper", async () => {
    const wrapperScript = join(root, "gradlew");
    const wrapperProperties = await text(
      "gradle/wrapper/gradle-wrapper.properties"
    );
    const wrapperJar = await readFile(
      join(root, "gradle", "wrapper", "gradle-wrapper.jar")
    );

    await expect(access(wrapperScript, constants.X_OK)).resolves.toBeUndefined();
    expect(wrapperProperties).toContain("gradle-8.9-bin.zip");
    expect(wrapperProperties).toContain(
      "distributionSha256Sum=d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab"
    );
    expect(createHash("sha256").update(wrapperJar).digest("hex"))
      .toBe("498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17");
  });

  it("keeps Package and Activity identities aligned", async () => {
    const config = AprConfigSchema.parse(await json("apr.config.json"));
    const journey = JourneySchema.parse(await json("journeys/search.json"));
    const manifest = await text("app/src/main/AndroidManifest.xml");
    const main = await text(
      "app/src/main/java/dev/apr/demo/MainActivity.kt"
    );
    const search = await text(
      "app/src/main/java/dev/apr/demo/SearchActivity.kt"
    );
    const appBuild = await text("app/build.gradle.kts");

    expect(config.run).toEqual({
      packageName: "dev.apr.demo",
      activity: ".MainActivity"
    });
    expect(appBuild).toContain('namespace = "dev.apr.demo"');
    expect(appBuild).toContain('applicationId = "dev.apr.demo"');
    expect(manifest).toContain('android:name=".MainActivity"');
    expect(manifest).toContain('android:name=".SearchActivity"');
    expect(main).toContain("package dev.apr.demo");
    expect(search).toContain("package dev.apr.demo");
    expect(journey.steps[0]?.activity).toEqual({
      before: "dev.apr.demo.MainActivity",
      after: "dev.apr.demo.SearchActivity"
    });
    expect(journey.steps.every((step) => (
      step.activity.before.startsWith("dev.apr.demo.")
      && step.activity.after.startsWith("dev.apr.demo.")
    ))).toBe(true);
  });

  it("keeps Journey Locators synchronized with Android resources", async () => {
    const journey = JourneySchema.parse(await json("journeys/search.json"));
    const mainLayout = await text("app/src/main/res/layout/activity_main.xml");
    const searchLayout = await text("app/src/main/res/layout/activity_search.xml");

    const resourceIds = journey.steps.flatMap((step) => {
      if ("locator" in step && step.locator.resourceId !== undefined) {
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

  it("matches the deterministic Logcat expectation to App behavior", async () => {
    const journey = JourneySchema.parse(await json("journeys/search.json"));
    const search = await text(
      "app/src/main/java/dev/apr/demo/SearchActivity.kt"
    );
    const logcat = journey.steps.find(
      (step) => step.expect?.type === "logcat"
    )?.expect;

    expect(logcat).toMatchObject({
      type: "logcat",
      tag: "SearchViewModel",
      level: "I",
      pattern: "submitted query=hello world",
      match: "literal"
    });
    expect(search).toContain('Log.i("SearchViewModel", "submitted query=$query")');
  });

  it("requires explicit opt-in before the device acceptance runner invokes APR", async () => {
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

    expect(runner).toContain("APR_ACCEPTANCE_DEVICE");
    expect(runner).toContain('"dist", "cli", "main.js"');
    expect(runner).toContain("verify");
    expect(runner).toContain("--json");
    expect(scripts?.["acceptance:device"])
      .toBe("node scripts/acceptance-device.mjs");
  });
});
