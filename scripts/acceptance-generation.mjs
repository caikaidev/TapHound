import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";

import { requireInstalledApp } from "./require-installed-app.mjs";

if (process.env.TAPHOUND_ACCEPTANCE_DEVICE !== "1") {
  process.stderr.write(
    "Skipping generation device acceptance. Set TAPHOUND_ACCEPTANCE_DEVICE=1 to opt in.\n"
  );
  process.exit(0);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const demoRoot = resolve(repositoryRoot, "examples", "taphound-android-demo");
const cli = resolve(repositoryRoot, "dist", "cli", "main.js");
const configPath = resolve(demoRoot, ".taphound", "config.json");
const contextDir = resolve(demoRoot, ".taphound", "context");
const contextPath = resolve(contextDir, "project-context.json");
const moduleDir = resolve(contextDir, "modules");
const modulePath = resolve(moduleDir, "app.json");

try {
  await access(cli);
} catch {
  throw new Error("Build TapHound first with `npm run build`");
}

requireInstalledApp("dev.taphound.demo");

const moduleFiles = [
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/dev/taphound/demo/MainActivity.kt",
  "app/src/main/java/dev/taphound/demo/SearchActivity.kt",
  "app/src/main/res/layout/activity_main.xml",
  "app/src/main/res/layout/activity_search.xml"
];
const projectFiles = ["settings.gradle.kts"];

async function sha256(relativePath) {
  const bytes = await readFile(resolve(demoRoot, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

await mkdir(moduleDir, { recursive: true });
const inventoryHash = createHash("sha256")
  .update([...moduleFiles].sort().join("\n"))
  .digest("hex");
const moduleContext = {
  version: 2,
  moduleId: ":app",
  projectDir: "app",
  status: "complete",
  inventory: {
    version: 2,
    pathSetSha256: inventoryHash,
    categories: ["manifests", "sources", "layouts", "navigation"]
  },
  manifest: {
    version: 1,
    files: await Promise.all(
      moduleFiles.map(async (path) => ({
        path,
        sha256: await sha256(path),
        confidence: "sourceConfirmed"
      }))
    )
  },
  summary: {
    features: ["launch", "search"],
    activities: [
      {
        name: "dev.taphound.demo.MainActivity",
        entryPoints: [],
        screens: ["home"]
      },
      {
        name: "dev.taphound.demo.SearchActivity",
        entryPoints: ["dev.taphound.demo.MainActivity"],
        screens: ["search"]
      }
    ],
    elements: [
      { screen: "home", resourceId: "open_search", actions: ["click"] },
      { screen: "search", resourceId: "search_input", actions: ["click", "inputText"] },
      { screen: "search", resourceId: "submit_search", actions: ["click"] }
    ],
    transitions: [{
      fromActivity: "dev.taphound.demo.MainActivity",
      actionResourceId: "open_search",
      toActivity: "dev.taphound.demo.SearchActivity"
    }],
    logcat: [{
      tag: "SearchViewModel",
      pattern: "submitted query=hello world",
      match: "literal"
    }]
  }
};
await writeFile(modulePath, `${JSON.stringify(moduleContext, null, 2)}\n`, "utf8");
const moduleHash = await sha256(".taphound/context/modules/app.json");
const projectContext = {
  version: 2,
  packageName: "dev.taphound.demo",
  launchActivity: "dev.taphound.demo.MainActivity",
  manifest: {
    version: 1,
    files: await Promise.all(
      projectFiles.map(async (path) => ({
        path,
        sha256: await sha256(path),
        confidence: "sourceConfirmed"
      }))
    )
  },
  interactionPolicy: {
    allowedActions: ["click", "longClick", "inputText", "swipe", "scrollTo", "back", "wait"],
    confirmationRequiredActions: [],
    forbiddenActions: []
  },
  modules: [{
    id: ":app",
    projectDir: "app",
    kind: "application",
    contextPath: ".taphound/context/modules/app.json",
    sha256: moduleHash,
    features: ["launch", "search"],
    activities: [
      "dev.taphound.demo.MainActivity",
      "dev.taphound.demo.SearchActivity"
    ],
    dependsOn: [],
    status: "complete"
  }]
};
await writeFile(contextPath, `${JSON.stringify(projectContext, null, 2)}\n`, "utf8");

const deviceArgs = process.env.TAPHOUND_DEVICE !== undefined
  ? ["--device", process.env.TAPHOUND_DEVICE]
  : [];

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.stdout.length === 0) {
    throw new Error(`CLI produced no stdout for: ${args.join(" ")}`);
  }
  const output = JSON.parse(result.stdout);
  if (result.status !== 0 || output.exitCode !== 0) {
    throw new Error(
      `CLI command failed (exit ${String(result.status)}): ${args.join(" ")}\n`
      + `status: ${output.status ?? "unknown"}\n`
      + `failure: ${JSON.stringify(output.failure ?? {})}`
    );
  }
  return output;
}

const startOutput = runCli([
  "generation", "start",
  "--project", demoRoot,
  "--config", configPath,
  "--context", contextPath,
  ...deviceArgs,
  "--json"
]);
const generationId = startOutput.generationId;

const stepTemplates = [
  {
    action: "click",
    locator: { resourceId: "open_search" },
    activity: {
      before: "dev.taphound.demo.MainActivity"
    },
    expect: {
      type: "element",
      locator: { resourceId: "search_input" },
      timeoutMs: 3000
    }
  },
  {
    action: "click",
    locator: { resourceId: "search_input" },
    activity: {
      before: "dev.taphound.demo.SearchActivity"
    }
  },
  {
    action: "inputText",
    text: "hello world",
    activity: {
      before: "dev.taphound.demo.SearchActivity"
    }
  },
  {
    action: "click",
    locator: { resourceId: "submit_search" },
    activity: {
      before: "dev.taphound.demo.SearchActivity"
    },
    expect: {
      type: "logcat",
      tag: "SearchViewModel",
      level: "I",
      pattern: "submitted query=hello world",
      match: "literal",
      timeoutMs: 3000
    }
  }
];

let observation = runCli([
  "generation", "observe",
  "--project", demoRoot,
  "--session", generationId,
  "--json"
]);

for (const [index, template] of stepTemplates.entries()) {
  const binding = {
    generationId: observation.generationId,
    baseRevision: observation.baseRevision,
    snapshotHash: observation.snapshotHash
  };
  const envelope = {
    version: 1,
    proposal: { ...template, binding },
    snapshot: observation.snapshot
  };
  const envelopePath = join(tmpdir(), `taphound-gen-step-${generationId}-${Date.now()}.json`);
  await writeFile(envelopePath, JSON.stringify(envelope), "utf8");
  let stepOutput;
  try {
    stepOutput = runCli([
      "generation", "step",
      "--project", demoRoot,
      "--session", generationId,
      "--input", envelopePath,
      "--json"
    ]);
  } finally {
    await rm(envelopePath, { force: true });
  }

  if (index < stepTemplates.length - 1) {
    if (stepOutput.nextBinding !== undefined && stepOutput.nextSnapshot !== undefined) {
      observation = {
        ...stepOutput.nextBinding,
        snapshot: stepOutput.nextSnapshot
      };
    } else {
      observation = runCli([
    "generation", "observe",
    "--project", demoRoot,
    "--session", generationId,
    "--json"
      ]);
    }
  }
}

const finalizeOutput = runCli([
  "generation", "finalize",
  "--project", demoRoot,
  "--session", generationId,
  "--context", contextPath,
  "--output", ".taphound/journeys/generated-search.json",
  ...deviceArgs,
  "--json"
]);

if (finalizeOutput.status !== "verified") {
  throw new Error(
    `Generation acceptance did not verify. status: ${String(finalizeOutput.status)}`
  );
}

process.stdout.write(
  `Generation acceptance passed.\n`
  + `bundle: ${finalizeOutput.bundlePath}\n`
  + `journey: ${finalizeOutput.journeyPath}\n`
  + `meta: ${finalizeOutput.metaPath}\n`
  + `replayed: ${String(finalizeOutput.replayed)}\n`
);
