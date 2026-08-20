import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProjectFileInspector } from "../../../src/adapters/filesystem/project-file-inspector.js";
import { NodeProjectInventoryInspector } from "../../../src/adapters/filesystem/project-inventory-inspector.js";
import {
  ContextLoadError,
  ContextLoader
} from "../../../src/application/context/context-loader.js";
import type {
  ProjectContextModule
} from "../../../src/domain/project-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(
  root: string,
  path: string,
  value: unknown
): Promise<string> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(absolute, bytes);
  return sha256(bytes);
}

function loader(): ContextLoader {
  return new ContextLoader({
    files: new NodeProjectFileInspector(),
    inventory: new NodeProjectInventoryInspector(),
    readJson: async (path) => JSON.parse(
      await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"))
    ) as unknown
  });
}

async function fixture(): Promise<{
  root: string;
  contextPath: string;
  featureSource: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-loader-"));
  roots.push(root);
  const appSource = "app/src/main/java/com/example/app/MainActivity.kt";
  const featureSource =
    "features/chat/src/main/java/com/example/chat/ChatActivity.kt";
  await mkdir(join(root, dirname(appSource)), { recursive: true });
  await mkdir(join(root, dirname(featureSource)), { recursive: true });
  await writeFile(join(root, "settings.gradle.kts"), "include(\":app\", \":chat\")");
  await writeFile(join(root, appSource), "class MainActivity");
  await writeFile(join(root, featureSource), "class ChatActivity");

  const module = (
    id: string,
    projectDir: string,
    source: string,
    features: string[]
  ): ProjectContextModule => ({
    version: 2,
    moduleId: id,
    projectDir,
    status: "complete",
    inventory: {
      version: 2,
      pathSetSha256: sha256(source),
      categories: ["sources"]
    },
    manifest: {
      version: 1,
      files: [{
        path: source,
        sha256: sha256(
          source === appSource ? "class MainActivity" : "class ChatActivity"
        ),
        confidence: "sourceConfirmed"
      }]
    },
    summary: {
      features,
      activities: id === ":app"
        ? [{
            name: "com.example.app.MainActivity",
            entryPoints: [],
            screens: []
          }]
        : [{
            name: "com.example.chat.ChatActivity",
            entryPoints: [],
            screens: []
          }],
      elements: [],
      transitions: [],
      logcat: []
    }
  });
  const appHash = await writeJson(
    root,
    ".taphound/context/modules/app.json",
    module(":app", "app", appSource, ["launch"])
  );
  const chatHash = await writeJson(
    root,
    ".taphound/context/modules/chat.json",
    module(":chat", "features/chat", featureSource, ["chat"])
  );
  const contextPath = ".taphound/context/project-context.json";
  await writeJson(root, contextPath, {
    version: 2,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: [{
        path: "settings.gradle.kts",
        sha256: sha256("include(\":app\", \":chat\")"),
        confidence: "sourceConfirmed"
      }]
    },
    interactionPolicy: {
      allowedActions: ["click", "wait"],
      confirmationRequiredActions: [],
      forbiddenActions: []
    },
    modules: [
      {
        id: ":app",
        projectDir: "app",
        kind: "application",
        contextPath: ".taphound/context/modules/app.json",
        sha256: appHash,
        features: ["launch"],
        activities: ["com.example.app.MainActivity"],
        dependsOn: [],
        status: "complete"
      },
      {
        id: ":chat",
        projectDir: "features/chat",
        kind: "feature",
        contextPath: ".taphound/context/modules/chat.json",
        sha256: chatHash,
        features: ["chat"],
        activities: ["com.example.chat.ChatActivity"],
        dependsOn: [],
        status: "complete"
      }
    ]
  });
  return { root, contextPath, featureSource };
}

describe("ContextLoader", () => {
  it("loads the application module plus selected feature modules", async () => {
    const test = await fixture();

    const loaded = await loader().load({
      projectRoot: test.root,
      contextPath: join(test.root, test.contextPath),
      moduleIds: [":chat"]
    });

    expect(loaded.modules.map((module) => module.moduleId))
      .toEqual([":app", ":chat"]);
    expect(loaded.context.selection.modules.map((module) => module.id))
      .toEqual([":app", ":chat"]);
    expect(loaded.context.manifest.files).toHaveLength(3);
  });

  it("expands declared module dependencies", async () => {
    const test = await fixture();
    const index = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) => readFile(
        join(test.root, test.contextPath),
        "utf8"
      ))
    ) as {
      modules: Array<{ id: string; dependsOn: string[] }>;
    };
    const chat = index.modules.find((module) => module.id === ":chat");
    if (chat === undefined) {
      throw new Error("Missing chat fixture module");
    }
    chat.dependsOn = [":app"];
    await writeJson(test.root, test.contextPath, index);

    const loaded = await loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath,
      moduleIds: [":chat"]
    });

    expect(loaded.context.selection.modules.map((module) => module.id))
      .toEqual([":app", ":chat"]);
  });

  it("rejects incomplete selected modules", async () => {
    const test = await fixture();
    const index = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) => readFile(
        join(test.root, test.contextPath),
        "utf8"
      ))
    ) as {
      modules: Array<{ id: string; status: string }>;
    };
    const chat = index.modules.find((module) => module.id === ":chat");
    if (chat === undefined) {
      throw new Error("Missing chat fixture module");
    }
    chat.status = "partial";
    await writeJson(test.root, test.contextPath, index);

    await expect(loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath,
      moduleIds: [":chat"]
    })).rejects.toEqual(expect.objectContaining<Partial<ContextLoadError>>({
      code: "CONTEXT_MODULE_INCOMPLETE"
    }));
  });

  it("rejects index routing summaries that diverge from the shard", async () => {
    const test = await fixture();
    const index = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) => readFile(
        join(test.root, test.contextPath),
        "utf8"
      ))
    ) as {
      modules: Array<{ id: string; features: string[] }>;
    };
    const chat = index.modules.find((module) => module.id === ":chat");
    if (chat === undefined) {
      throw new Error("Missing chat fixture module");
    }
    chat.features = ["misrouted"];
    await writeJson(test.root, test.contextPath, index);

    await expect(loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath,
      moduleIds: [":chat"]
    })).rejects.toEqual(expect.objectContaining<Partial<ContextLoadError>>({
      code: "CONTEXT_INVALID",
      message: "Context shard routing summary does not match its index: :chat"
    }));
  });

  it("rejects version 1 single-file Context", async () => {
    const test = await fixture();
    await writeJson(test.root, test.contextPath, {
      version: 1,
      packageName: "com.example.app"
    });

    await expect(loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath
    })).rejects.toEqual(expect.objectContaining<Partial<ContextLoadError>>({
      code: "CONTEXT_INVALID"
    }));
  });

  it("detects a new module source through the inventory path-set hash", async () => {
    const test = await fixture();
    await writeFile(
      join(test.root, "features/chat/src/main/java/com/example/chat/New.kt"),
      "class New"
    );

    await expect(loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath,
      moduleIds: [":chat"]
    })).rejects.toEqual(expect.objectContaining<Partial<ContextLoadError>>({
      code: "CONTEXT_STALE",
      message: "Module file inventory changed: :chat"
    }));
  });

  it("detects a modified module shard before trusting its content", async () => {
    const test = await fixture();
    await writeFile(
      join(test.root, ".taphound/context/modules/chat.json"),
      "{}\n"
    );

    await expect(loader().load({
      projectRoot: test.root,
      contextPath: test.contextPath,
      moduleIds: [":chat"]
    })).rejects.toEqual(expect.objectContaining<Partial<ContextLoadError>>({
      code: "CONTEXT_STALE"
    }));
  });
});
