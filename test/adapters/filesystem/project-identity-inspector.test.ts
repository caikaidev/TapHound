import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AndroidProjectIdentityInspector } from "../../../src/adapters/filesystem/project-identity-inspector.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-identity-"));
  roots.push(root);
  return root;
}

async function writeAppModule(
  root: string,
  buildContent: string,
  manifestContent: string
): Promise<string> {
  const moduleDir = join(root, "app");
  await mkdir(join(moduleDir, "src", "main"), { recursive: true });
  await writeFile(join(moduleDir, "build.gradle.kts"), buildContent, "utf8");
  await writeFile(
    join(moduleDir, "src", "main", "AndroidManifest.xml"),
    manifestContent,
    "utf8"
  );
  return moduleDir;
}

const MANIFEST_WITH_LAUNCHER = [
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
  "    <application>",
  '        <activity android:name=".ui.SplashActivity">',
  "            <intent-filter>",
  '                <action android:name="android.intent.action.MAIN" />',
  '                <category android:name="android.intent.category.LAUNCHER" />',
  "            </intent-filter>",
  "        </activity>",
  "    </application>",
  "</manifest>",
].join("\n");

describe("AndroidProjectIdentityInspector", () => {
  it("resolves applicationId from Kotlin DSL literal", async () => {
    const root = await temporaryRoot();
    await writeAppModule(
      root,
      [
        "android {",
        '    namespace = "com.example.app"',
        "    defaultConfig {",
        '        applicationId = "com.example.app.release"',
        "    }",
        "}",
      ].join("\n"),
      MANIFEST_WITH_LAUNCHER
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.packageName).toBe("com.example.app.release");
    expect(result.launchActivity).toBe("com.example.app.ui.SplashActivity");
  });

  it("resolves applicationId from Groovy literal", async () => {
    const root = await temporaryRoot();
    const moduleDir = join(root, "app");
    await mkdir(join(moduleDir, "src", "main"), { recursive: true });
    await writeFile(
      join(moduleDir, "build.gradle"),
      [
        "android {",
        '    namespace "com.example.app"',
        "    defaultConfig {",
        "        applicationId 'com.example.groovy'",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(moduleDir, "src", "main", "AndroidManifest.xml"),
      MANIFEST_WITH_LAUNCHER,
      "utf8"
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.packageName).toBe("com.example.groovy");
  });

  it("resolves applicationId from gradle.properties via variable chain", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "gradle.properties"),
      "tChatSupplierApplicationId=com.sample.tchat\n",
      "utf8"
    );
    await writeAppModule(
      root,
      [
        'val buildApplicationId = providers.gradleProperty("tChatSupplierApplicationId").get()',
        "android {",
        '    namespace = "com.sample.im"',
        "    defaultConfig {",
        "        applicationId = buildApplicationId",
      ].join("\n"),
      MANIFEST_WITH_LAUNCHER
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.packageName).toBe("com.sample.tchat");
    expect(result.launchActivity).toBe("com.sample.im.ui.SplashActivity");
  });

  it("falls back to namespace when applicationId is not a literal or variable", async () => {
    const root = await temporaryRoot();
    await writeAppModule(
      root,
      [
        "android {",
        '    namespace = "com.example.fallback"',
      ].join("\n"),
      MANIFEST_WITH_LAUNCHER
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.packageName).toBe("com.example.fallback");
  });

  it("falls back to manifest package attribute when build file has no applicationId", async () => {
    const root = await temporaryRoot();
    const manifestWithPackage = MANIFEST_WITH_LAUNCHER.replace(
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.frommanifest">'
    );
    await writeAppModule(root, "android { }\n", manifestWithPackage);

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.packageName).toBe("com.example.frommanifest");
  });

  it("resolves fully-qualified activity name without prefix", async () => {
    const root = await temporaryRoot();
    const manifest = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "    <application>",
      '        <activity android:name="com.example.full.MainActivity">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.MAIN" />',
      '                <category android:name="android.intent.category.LAUNCHER" />',
      "            </intent-filter>",
      "        </activity>",
      "    </application>",
      "</manifest>",
    ].join("\n");
    await writeAppModule(
      root,
      'android { namespace = "com.example" }\n',
      manifest
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.launchActivity).toBe("com.example.full.MainActivity");
  });

  it("returns identityNotFound when no launch activity exists", async () => {
    const root = await temporaryRoot();
    const manifestNoLauncher = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "    <application>",
      '        <activity android:name=".NoLauncherActivity" />',
      "    </application>",
      "</manifest>",
    ].join("\n");
    await writeAppModule(
      root,
      'android { namespace = "com.example" }\n',
      manifestNoLauncher
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("identityNotFound");
  });

  it("returns manifestNotFound when manifest is missing", async () => {
    const root = await temporaryRoot();
    const moduleDir = join(root, "app");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "build.gradle.kts"),
      'android { namespace = "com.example" }\n',
      "utf8"
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("manifestNotFound");
  });

  it("returns moduleNotFound when module directory does not exist", async () => {
    const root = await temporaryRoot();

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "nonexistent"
    });

    expect(result.status).toBe("moduleNotFound");
  });

  it("returns rootNotFound for nonexistent project root", async () => {
    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: join(tmpdir(), `taphound-nonexistent-${String(Date.now())}`),
      moduleDir: "app"
    });

    expect(result.status).toBe("rootNotFound");
  });

  it("picks the first activity with MAIN+LAUNCHER when multiple activities exist", async () => {
    const root = await temporaryRoot();
    const manifest = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "    <application>",
      '        <activity android:name=".NormalActivity">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.VIEW" />',
      "            </intent-filter>",
      "        </activity>",
      '        <activity android:name=".LauncherActivity">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.MAIN" />',
      '                <category android:name="android.intent.category.LAUNCHER" />',
      "            </intent-filter>",
      "        </activity>",
      "    </application>",
      "</manifest>",
    ].join("\n");
    await writeAppModule(
      root,
      'android { namespace = "com.example" }\n',
      manifest
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.launchActivity).toBe("com.example.LauncherActivity");
  });

  it("does not steal intent-filter from next activity when self-closing activity comes first", async () => {
    const root = await temporaryRoot();
    const manifest = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "    <application>",
      '        <activity android:name=".SearchActivity" android:exported="false" />',
      '        <activity android:name=".MainActivity" android:exported="true">',
      "            <intent-filter>",
      '                <action android:name="android.intent.action.MAIN" />',
      '                <category android:name="android.intent.category.LAUNCHER" />',
      "            </intent-filter>",
      "        </activity>",
      "    </application>",
      "</manifest>",
    ].join("\n");
    await writeAppModule(
      root,
      'android { namespace = "com.example" }\n',
      manifest
    );

    const inspector = new AndroidProjectIdentityInspector();
    const result = await inspector.inspectIdentity({
      projectRoot: root,
      moduleDir: "app"
    });

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") return;
    expect(result.launchActivity).toBe("com.example.MainActivity");
  });
});
