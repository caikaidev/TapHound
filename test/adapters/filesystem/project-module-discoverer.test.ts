import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GradleProjectModuleDiscoverer } from "../../../src/adapters/filesystem/project-module-discoverer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-discoverer-"));
  roots.push(root);
  return root;
}

async function writeModule(
  root: string,
  dir: string,
  buildContent: string
): Promise<void> {
  const moduleDir = join(root, dir);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(join(moduleDir, "build.gradle.kts"), buildContent, "utf8");
}

describe("GradleProjectModuleDiscoverer", () => {
  it("discovers modules from standard include calls", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      [
        'include(":app")',
        'include(":lib1", ":lib2")',
        'rootProject.name = "test"'
      ].join("\n"),
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');
    await writeModule(root, "lib1", 'plugins { id("com.android.library") }\n');
    await writeModule(root, "lib2", 'plugins { id("com.android.library") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const ids = result.modules.map((m) => m.id).sort();
    expect(ids).toEqual([":app", ":lib1", ":lib2"]);
    const app = result.modules.find((m) => m.id === ":app");
    expect(app?.kind).toBe("application");
  });

  it("discovers modules from listOf with to-pairs and forEach include", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      [
        'include(":app")',
        'rootProject.name = "test"',
        "",
        "val modules = listOf(",
        '    ":lib1"          to "lib1",',
        '    ":lib2"          to "custom/lib2",',
        '    ":feature:secure" to "feature/secure/secure_impl",',
        ")",
        "",
        "modules.forEach { (path, dir) ->",
        "    include(path)",
        '    project(path).projectDir = file("$rootDir/$dir")',
        "}",
      ].join("\n"),
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');
    await writeModule(root, "lib1", 'plugins { id("com.android.library") }\n');
    await writeModule(root, "custom/lib2", 'plugins { id("com.android.library") }\n');
    await writeModule(
      root,
      "feature/secure/secure_impl",
      'plugins { id("com.android.library") }\n'
    );

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const ids = result.modules.map((m) => m.id).sort();
    expect(ids).toEqual([":app", ":feature:secure", ":lib1", ":lib2"]);

    const lib2 = result.modules.find((m) => m.id === ":lib2");
    expect(lib2?.projectDir).toBe("custom/lib2");

    const secure = result.modules.find((m) => m.id === ":feature:secure");
    expect(secure?.projectDir).toBe("feature/secure/secure_impl");
  });

  it("respects explicit projectDir overrides with $rootDir prefix", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      [
        'include(":app")',
        'include(":lib")',
        'rootProject.name = "test"',
        'project(":lib").projectDir = file("$rootDir/custom/location")',
      ].join("\n"),
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');
    await writeModule(root, "custom/location", 'plugins { id("com.android.library") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const lib = result.modules.find((m) => m.id === ":lib");
    expect(lib?.projectDir).toBe("custom/location");
  });

  it("respects Groovy-style projectDir overrides with new File", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle"),
      [
        "include ':app'",
        "include ':lib'",
        "rootProject.name = 'test'",
        "project(':lib').projectDir = new File(rootDir, 'custom/location')",
      ].join("\n"),
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');
    await writeModule(root, "custom/location", 'plugins { id("com.android.library") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const lib = result.modules.find((m) => m.id === ":lib");
    expect(lib?.projectDir).toBe("custom/location");
  });

  it("detects convention plugins like im.android.application.compose", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":app")\nrootProject.name = "test"\n',
      "utf8"
    );
    await writeModule(
      root,
      "app",
      [
        "plugins {",
        '    id("im.android.application.compose")',
        '    id("org.jetbrains.kotlin.plugin.serialization")',
        "}",
      ].join("\n")
    );

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    expect(result.modules[0]?.kind).toBe("application");
  });

  it("detects convention plugins via apply(plugin = ...)", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":app")\nrootProject.name = "test"\n',
      "utf8"
    );
    await writeModule(
      root,
      "app",
      [
        "plugins {",
        '    id("something.else")',
        "}",
        'apply(plugin = "my.android.application")',
      ].join("\n")
    );

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    expect(result.modules[0]?.kind).toBe("application");
  });

  it("detects dynamic-feature convention plugins", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      [
        'include(":app")',
        'include(":feature")',
        'rootProject.name = "test"',
      ].join("\n"),
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');
    await writeModule(
      root,
      "feature",
      'plugins { id("com.android.dynamic-feature") }\n'
    );

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const feature = result.modules.find((m) => m.id === ":feature");
    expect(feature?.kind).toBe("feature");
  });

  it("returns noApplicationModule when no app plugin is found", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":lib")\nrootProject.name = "test"\n',
      "utf8"
    );
    await writeModule(root, "lib", 'plugins { id("com.android.library") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("noApplicationModule");
  });

  it("returns noSettingsFile when no settings file exists", async () => {
    const root = await temporaryRoot();

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("noSettingsFile");
  });

  it("returns rootNotFound for nonexistent project root", async () => {
    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({
      projectRoot: join(tmpdir(), `taphound-nonexistent-${String(Date.now())}`)
    });

    expect(result.status).toBe("rootNotFound");
  });

  it("parses project dependencies from build files", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":app", ":lib1", ":lib2")\nrootProject.name = "test"\n',
      "utf8"
    );
    await writeModule(root, "app", [
      'plugins { id("com.android.application") }',
      "dependencies {",
      '    implementation(project(":lib1"))',
      '    implementation(project(":lib2"))',
      "}",
    ].join("\n"));
    await writeModule(root, "lib1", 'plugins { id("com.android.library") }\n');
    await writeModule(root, "lib2", 'plugins { id("com.android.library") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const app = result.modules.find((m) => m.id === ":app");
    expect(app?.dependsOn).toEqual([":lib1", ":lib2"]);
  });

  it("skips modules whose directory does not exist", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":app", ":missing")\nrootProject.name = "test"\n',
      "utf8"
    );
    await writeModule(root, "app", 'plugins { id("com.android.application") }\n');

    const discoverer = new GradleProjectModuleDiscoverer();
    const result = await discoverer.discoverModules({ projectRoot: root });

    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") return;
    const ids = result.modules.map((m) => m.id);
    expect(ids).toEqual([":app"]);
  });
});
