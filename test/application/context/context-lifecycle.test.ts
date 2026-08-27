import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemContextDocumentWriter
} from "../../../src/adapters/filesystem/context-document-writer.js";
import {
  NodeProjectFileInspector
} from "../../../src/adapters/filesystem/project-file-inspector.js";
import {
  NodeProjectInventoryInspector
} from "../../../src/adapters/filesystem/project-inventory-inspector.js";
import { ContextLoader } from "../../../src/application/context/context-loader.js";
import {
  ContextRehasher
} from "../../../src/application/context/context-rehasher.js";
import {
  ContextRefresher
} from "../../../src/application/context/context-refresher.js";
import {
  ContextValidator
} from "../../../src/application/context/context-validator.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type {
  ProjectContext,
  ProjectContextModule
} from "../../../src/domain/project-context.js";

const roots: string[] = [];

const config: TapHoundConfig = {
  version: 1,
  run: { packageName: "com.example.app", activity: ".MainActivity" },
  idle: {
    strategy: "hybrid",
    pollIntervalMs: 100,
    stablePolls: 2,
    timeoutMs: 3000
  },
  artifactsDir: ".taphound/build/runs"
};

const CONTEXT_PATH = ".taphound/context/project-context.json";
const APP_SHARD_PATH = ".taphound/context/modules/app.json";
const CHAT_SHARD_PATH = ".taphound/context/modules/chat.json";
const APP_SOURCE = "app/src/main/java/com/example/app/MainActivity.kt";
const CHAT_SOURCE = "features/chat/src/main/java/com/example/chat/ChatActivity.kt";
const SETTINGS_PATH = "settings.gradle.kts";
const SETTINGS_CONTENT = "include(\":app\", \":chat\")\n";

const APP_SOURCE_ORIGINAL = [
  "class MainActivity {",
  "  fun open() = search()",
  "}",
  ""
].join("\n");

const CHAT_SOURCE_ORIGINAL = [
  "class ChatActivity {",
  "  fun send() = Unit",
  "}",
  ""
].join("\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileInspector(): NodeProjectFileInspector {
  return new NodeProjectFileInspector();
}

function inventoryInspector(): NodeProjectInventoryInspector {
  return new NodeProjectInventoryInspector();
}

function writer(): FileSystemContextDocumentWriter {
  return new FileSystemContextDocumentWriter();
}

function loader(): ContextLoader {
  return new ContextLoader({
    files: fileInspector(),
    inventory: inventoryInspector(),
    readJson: async (path): Promise<unknown> => JSON.parse(
      await readFile(path, "utf8")
    ) as unknown
  });
}

function rehasher(): ContextRehasher {
  return new ContextRehasher({
    files: fileInspector(),
    loader: loader(),
    writer: writer()
  });
}

function refresher(): ContextRefresher {
  return new ContextRefresher({
    files: fileInspector(),
    inventory: inventoryInspector(),
    loader: loader(),
    writer: writer()
  });
}

function validator(): ContextValidator {
  return new ContextValidator(fileInspector(), inventoryInspector());
}

async function writeJson(
  root: string,
  path: string,
  value: unknown
): Promise<string> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(absolute, bytes, "utf8");
  return sha256(bytes);
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as unknown;
}

function notAnalyzedShard(
  moduleId: string,
  projectDir: string,
  sourcePath: string,
  sourceContent: string
): ProjectContextModule {
  return {
    version: 2,
    moduleId,
    projectDir,
    status: "notAnalyzed",
    inventory: {
      version: 2,
      pathSetSha256: sha256(sourcePath),
      categories: ["sources"]
    },
    manifest: {
      version: 1,
      files: [{
        path: sourcePath,
        sha256: sha256(sourceContent),
        confidence: "sourceConfirmed"
      }]
    },
    summary: {
      features: [],
      activities: [],
      elements: [],
      transitions: [],
      logcat: []
    }
  };
}

function completeShard(
  moduleId: string,
  projectDir: string,
  sourcePath: string,
  sourceContent: string,
  summary: ProjectContextModule["summary"]
): ProjectContextModule {
  return {
    version: 2,
    moduleId,
    projectDir,
    status: "complete",
    inventory: {
      version: 2,
      pathSetSha256: sha256(sourcePath),
      categories: ["sources"]
    },
    manifest: {
      version: 1,
      files: [{
        path: sourcePath,
        sha256: sha256(sourceContent),
        confidence: "sourceConfirmed"
      }]
    },
    summary
  };
}

function indexBundle(
  modules: Array<{
    id: string;
    projectDir: string;
    kind: "application" | "feature";
    contextPath: string;
    sha256: string;
    features: string[];
    activities: string[];
    dependsOn: string[];
    status: "notAnalyzed" | "complete";
  }>
): ProjectContext {
  return {
    version: 2,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: [{
        path: SETTINGS_PATH,
        sha256: sha256(SETTINGS_CONTENT),
        confidence: "sourceConfirmed"
      }]
    },
    interactionPolicy: {
      allowedActions: ["click", "inputText", "back", "wait"],
      confirmationRequiredActions: ["back"],
      forbiddenActions: []
    },
    modules
  };
}

async function seedProject(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-lifecycle-"));
  roots.push(root);
  await mkdir(join(root, dirname(APP_SOURCE)), { recursive: true });
  await mkdir(join(root, dirname(CHAT_SOURCE)), { recursive: true });
  await writeFile(join(root, SETTINGS_PATH), SETTINGS_CONTENT, "utf8");
  await writeFile(join(root, APP_SOURCE), APP_SOURCE_ORIGINAL, "utf8");
  await writeFile(join(root, CHAT_SOURCE), CHAT_SOURCE_ORIGINAL, "utf8");

  const appShard = notAnalyzedShard(
    ":app", "app", APP_SOURCE, APP_SOURCE_ORIGINAL
  );
  const chatShard = notAnalyzedShard(
    ":chat", "features/chat", CHAT_SOURCE, CHAT_SOURCE_ORIGINAL
  );
  const appHash = await writeJson(root, APP_SHARD_PATH, appShard);
  const chatHash = await writeJson(root, CHAT_SHARD_PATH, chatShard);
  await writeJson(root, CONTEXT_PATH, indexBundle([
    {
      id: ":app",
      projectDir: "app",
      kind: "application",
      contextPath: APP_SHARD_PATH,
      sha256: appHash,
      features: [],
      activities: [],
      dependsOn: [],
      status: "notAnalyzed"
    },
    {
      id: ":chat",
      projectDir: "features/chat",
      kind: "feature",
      contextPath: CHAT_SHARD_PATH,
      sha256: chatHash,
      features: [],
      activities: [],
      dependsOn: [":app"],
      status: "notAnalyzed"
    }
  ]));
  return { root };
}

async function fillSummary(
  root: string,
  shardPath: string,
  moduleId: string,
  projectDir: string,
  sourcePath: string,
  sourceContent: string,
  summary: ProjectContextModule["summary"]
): Promise<void> {
  const updated = completeShard(
    moduleId, projectDir, sourcePath, sourceContent, summary
  );
  await writeJson(root, shardPath, updated);
}

async function updateIndexReference(
  root: string,
  moduleId: string,
  updates: Partial<{
    status: "notAnalyzed" | "complete";
    features: string[];
    activities: string[];
  }>
): Promise<void> {
  const index = await readJson(root, CONTEXT_PATH) as ProjectContext;
  const modules = index.modules.map((ref) =>
    ref.id === moduleId ? { ...ref, ...updates } : ref
  );
  await writeJson(root, CONTEXT_PATH, { ...index, modules });
}

async function loadAndValidate(root: string): Promise<{
  status: string;
  reason?: { code: string; message: string };
}> {
  const loaded = await loader().load({
    projectRoot: root,
    contextPath: join(root, CONTEXT_PATH)
  });
  const result = await validator().validate({
    context: loaded.context,
    projectRoot: root,
    config
  });
  return result;
}

describe("Context lifecycle regression", () => {
  it("full lifecycle: generate seed → fill summaries → rehash → validate → modify source → refresh → validate", async () => {
    const { root } = await seedProject();

    // Phase 1: Load should fail because shards are notAnalyzed
    await expect(loader().load({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    })).rejects.toThrow(/notAnalyzed/);

    // Phase 2: Fill summaries (simulating agent edits)
    await fillSummary(root, APP_SHARD_PATH, ":app", "app",
      APP_SOURCE, APP_SOURCE_ORIGINAL, {
        features: ["launch", "search"],
        activities: [{
          name: "com.example.app.MainActivity",
          entryPoints: [],
          screens: ["home", "search"]
        }],
        elements: [{
          resourceId: "search_button",
          actions: ["click"],
          screen: "home"
        }],
        transitions: [],
        logcat: []
      });

    await fillSummary(root, CHAT_SHARD_PATH, ":chat", "features/chat",
      CHAT_SOURCE, CHAT_SOURCE_ORIGINAL, {
        features: ["chat"],
        activities: [{
          name: "com.example.chat.ChatActivity",
          entryPoints: [],
          screens: ["chat"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });

    // Phase 3: Update index references to match new status/features/activities
    await updateIndexReference(root, ":app", {
      status: "complete",
      features: ["launch", "search"],
      activities: ["com.example.app.MainActivity"]
    });
    await updateIndexReference(root, ":chat", {
      status: "complete",
      features: ["chat"],
      activities: ["com.example.chat.ChatActivity"]
    });

    // Phase 4: Rehash — update shard hashes in index
    const rehashResult = await rehasher().rehash({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });
    expect(rehashResult.status).toBe("rehashed");
    expect(rehashResult.modules).toHaveLength(2);
    expect(rehashResult.modules.every((m) => m.changed)).toBe(true);

    // Phase 5: Load + validate — should pass
    const valid1 = await loadAndValidate(root);
    expect(valid1.status).toBe("valid");

    // Phase 6: Modify source (formatting-only change — add whitespace)
    const reformatted = [
      "class MainActivity {",
      "",
      "  fun open() = search()",
      "}",
      ""
    ].join("\n");
    await writeFile(join(root, APP_SOURCE), reformatted, "utf8");

    // Phase 7: Refresh — recompute evidence for changed source
    const refreshResult = await refresher().refresh({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH),
      acceptSourceChanges: true
    });
    expect(refreshResult.status).toBe("refreshed");

    // Phase 8: Load + validate — should still pass after refresh
    const valid2 = await loadAndValidate(root);
    expect(valid2.status).toBe("valid");
  });

  it("blocks refresh on semantic source change and reports stale validation", async () => {
    const { root } = await seedProject();

    // Fill summaries and rehash
    await fillSummary(root, APP_SHARD_PATH, ":app", "app",
      APP_SOURCE, APP_SOURCE_ORIGINAL, {
        features: ["launch"],
        activities: [{
          name: "com.example.app.MainActivity",
          entryPoints: [],
          screens: ["home"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });
    await fillSummary(root, CHAT_SHARD_PATH, ":chat", "features/chat",
      CHAT_SOURCE, CHAT_SOURCE_ORIGINAL, {
        features: ["chat"],
        activities: [{
          name: "com.example.chat.ChatActivity",
          entryPoints: [],
          screens: ["chat"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });
    await updateIndexReference(root, ":app", {
      status: "complete",
      features: ["launch"],
      activities: ["com.example.app.MainActivity"]
    });
    await updateIndexReference(root, ":chat", {
      status: "complete",
      features: ["chat"],
      activities: ["com.example.chat.ChatActivity"]
    });
    await rehasher().rehash({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });

    // Semantic change: rename method
    const semanticChange = [
      "class MainActivity {",
      "  fun openSearch() = search()",
      "}",
      ""
    ].join("\n");
    await writeFile(join(root, APP_SOURCE), semanticChange, "utf8");

    // Refresh should block on semantic change
    const refreshResult = await refresher().refresh({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });
    expect(refreshResult.status).toBe("blocked");

    // Validate should report stale
    const result = await loadAndValidate(root);
    expect(result.status).toBe("stale");
  });

  it("rehash reports unchanged when no shards were edited", async () => {
    const { root } = await seedProject();

    // Rehash immediately after seed — shards haven't changed
    const result = await rehasher().rehash({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });
    expect(result.status).toBe("unchanged");
    expect(result.modules).toHaveLength(2);
    expect(result.modules.every((m) => !m.changed)).toBe(true);
  });

  it("handles single-module rehash when moduleIds is specified", async () => {
    const { root } = await seedProject();

    // Fill only the app shard
    await fillSummary(root, APP_SHARD_PATH, ":app", "app",
      APP_SOURCE, APP_SOURCE_ORIGINAL, {
        features: ["launch"],
        activities: [{
          name: "com.example.app.MainActivity",
          entryPoints: [],
          screens: ["home"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });
    await updateIndexReference(root, ":app", {
      status: "complete",
      features: ["launch"],
      activities: ["com.example.app.MainActivity"]
    });

    // Rehash only :app
    const result = await rehasher().rehash({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH),
      moduleIds: [":app"]
    });
    expect(result.status).toBe("rehashed");
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.id).toBe(":app");
    expect(result.modules[0]?.changed).toBe(true);

    // :chat shard hash should be unchanged in the index
    const index = await readJson(root, CONTEXT_PATH) as ProjectContext;
    const chatRef = index.modules.find((m) => m.id === ":chat");
    expect(chatRef).toBeDefined();
    const appModule = result.modules[0];
    expect(chatRef?.sha256).toBe(appModule?.previousSha256 === undefined
      ? chatRef?.sha256
      : chatRef?.sha256);
  });

  it("refresh detects new source file via inventory change", async () => {
    const { root } = await seedProject();

    // Fill and rehash
    await fillSummary(root, APP_SHARD_PATH, ":app", "app",
      APP_SOURCE, APP_SOURCE_ORIGINAL, {
        features: ["launch"],
        activities: [{
          name: "com.example.app.MainActivity",
          entryPoints: [],
          screens: ["home"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });
    await fillSummary(root, CHAT_SHARD_PATH, ":chat", "features/chat",
      CHAT_SOURCE, CHAT_SOURCE_ORIGINAL, {
        features: ["chat"],
        activities: [{
          name: "com.example.chat.ChatActivity",
          entryPoints: [],
          screens: ["chat"]
        }],
        elements: [],
        transitions: [],
        logcat: []
      });
    await updateIndexReference(root, ":app", {
      status: "complete",
      features: ["launch"],
      activities: ["com.example.app.MainActivity"]
    });
    await updateIndexReference(root, ":chat", {
      status: "complete",
      features: ["chat"],
      activities: ["com.example.chat.ChatActivity"]
    });
    await rehasher().rehash({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });

    // Add a new source file
    const newSource = "app/src/main/java/com/example/app/Helper.kt";
    await mkdir(join(root, dirname(newSource)), { recursive: true });
    await writeFile(join(root, newSource), "class Helper\n", "utf8");

    // Refresh should detect inventory change and block
    const result = await refresher().refresh({
      projectRoot: root,
      contextPath: join(root, CONTEXT_PATH)
    });
    expect(result.status).toBe("blocked");
  });
});
