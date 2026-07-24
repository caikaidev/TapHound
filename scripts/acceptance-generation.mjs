import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";

if (process.env.TAPHOUND_ACCEPTANCE_DEVICE !== "1") {
  process.stderr.write(
    "Skipping generation device acceptance. Set TAPHOUND_ACCEPTANCE_DEVICE=1 to opt in.\n"
  );
  process.exit(0);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const demoRoot = resolve(repositoryRoot, "examples", "taphound-android-demo");
const cli = resolve(repositoryRoot, "dist", "cli", "main.js");
const configPath = resolve(demoRoot, "taphound.config.json");
const contextDir = resolve(demoRoot, ".taphound", "context");
const contextPath = resolve(contextDir, "project-context.json");
const gradleWrapper = resolve(demoRoot, "gradlew");

try {
  await access(cli);
} catch {
  throw new Error("Build TapHound first with `npm run build`");
}

try {
  await access(gradleWrapper);
} catch {
  throw new Error(
    "Generation device acceptance requires a Gradle Wrapper at "
      + "examples/taphound-android-demo/gradlew"
  );
}

const manifestFiles = [
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/dev/taphound/demo/MainActivity.kt",
  "app/src/main/java/dev/taphound/demo/SearchActivity.kt",
  "app/src/main/res/layout/activity_main.xml",
  "app/src/main/res/layout/activity_search.xml"
];

async function sha256(relativePath) {
  const bytes = await readFile(resolve(demoRoot, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

await mkdir(contextDir, { recursive: true });
const projectContext = {
  version: 1,
  packageName: "dev.taphound.demo",
  launchActivity: "dev.taphound.demo.MainActivity",
  manifest: {
    version: 1,
    files: await Promise.all(
      manifestFiles.map(async (path) => ({
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
  }
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
      before: "dev.taphound.demo.MainActivity",
      after: "dev.taphound.demo.SearchActivity"
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
      before: "dev.taphound.demo.SearchActivity",
      after: "dev.taphound.demo.SearchActivity"
    }
  },
  {
    action: "inputText",
    text: "hello world",
    activity: {
      before: "dev.taphound.demo.SearchActivity",
      after: "dev.taphound.demo.SearchActivity"
    }
  },
  {
    action: "click",
    locator: { resourceId: "submit_search" },
    activity: {
      before: "dev.taphound.demo.SearchActivity",
      after: "dev.taphound.demo.SearchActivity"
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

for (const template of stepTemplates) {
  const observeOutput = runCli([
    "generation", "observe",
    "--project", demoRoot,
    "--session", generationId,
    ...deviceArgs,
    "--json"
  ]);
  const binding = {
    generationId: observeOutput.generationId,
    baseRevision: observeOutput.baseRevision,
    snapshotHash: observeOutput.snapshotHash
  };
  const envelope = {
    version: 1,
    proposal: { ...template, binding },
    snapshot: observeOutput.snapshot
  };
  const envelopePath = join(tmpdir(), `taphound-gen-step-${generationId}-${Date.now()}.json`);
  await writeFile(envelopePath, JSON.stringify(envelope), "utf8");
  try {
    runCli([
      "generation", "step",
      "--project", demoRoot,
      "--session", generationId,
      "--input", envelopePath,
      "--json"
    ]);
  } finally {
    await rm(envelopePath, { force: true });
  }
}

const finalizeOutput = runCli([
  "generation", "finalize",
  "--project", demoRoot,
  "--session", generationId,
  "--context", contextPath,
  "--output", "journeys/generated-search.json",
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
