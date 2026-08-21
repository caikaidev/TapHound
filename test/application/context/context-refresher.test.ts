import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
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
  ContextRefreshError,
  ContextRefresher
} from "../../../src/application/context/context-refresher.js";
import {
  ContextValidator
} from "../../../src/application/context/context-validator.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type {
  ProjectContextModule
} from "../../../src/domain/project-context.js";

const roots: string[] = [];

const config: TapHoundConfig = {
  version: 1,
  run: {
    packageName: "com.example.app",
    activity: ".MainActivity"
  },
  idle: {
    pollIntervalMs: 100,
    stablePolls: 2,
    timeoutMs: 3000
  },
  artifactsDir: ".taphound/runs"
};

const APP_SOURCE = "app/src/main/java/com/example/app/MainActivity.kt";
const APP_SOURCE_CONTENT = [
  "class MainActivity {",
  "  // opens search",
  "  fun open() = search()",
  "}",
  ""
].join("\n");
const SETTINGS_CONTENT = "include(\":app\")\n";
const CONTEXT_PATH = ".taphound/context/project-context.json";
const SHARD_PATH = ".taphound/context/modules/app.json";
const HELPER_SOURCE = "app/src/main/java/com/example/app/Helper.kt";
const HELPER_SOURCE_CONTENT = "class Helper\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function loader(): ContextLoader {
  return new ContextLoader({
    files: new NodeProjectFileInspector(),
    inventory: new NodeProjectInventoryInspector(),
    readJson: async (path): Promise<unknown> => JSON.parse(
      await readFile(path, "utf8")
    ) as unknown
  });
}

function refresher(): ContextRefresher {
  return new ContextRefresher({
    files: new NodeProjectFileInspector(),
    inventory: new NodeProjectInventoryInspector(),
    loader: loader(),
    writer: new FileSystemContextDocumentWriter()
  });
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

async function fixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-refresh-"));
  roots.push(root);
  await mkdir(join(root, dirname(APP_SOURCE)), { recursive: true });
  await writeFile(join(root, "settings.gradle.kts"), SETTINGS_CONTENT, "utf8");
  await writeFile(join(root, APP_SOURCE), APP_SOURCE_CONTENT, "utf8");

  const shard: ProjectContextModule = {
    version: 2,
    moduleId: ":app",
    projectDir: "app",
    status: "complete",
    inventory: {
      version: 2,
      pathSetSha256: sha256(APP_SOURCE),
      categories: ["sources"]
    },
    manifest: {
      version: 1,
      files: [{
        path: APP_SOURCE,
        sha256: sha256(APP_SOURCE_CONTENT),
        confidence: "sourceConfirmed"
      }]
    },
    summary: {
      features: ["launch"],
      activities: [{
        name: "com.example.app.MainActivity",
        entryPoints: [],
        screens: ["home"]
      }],
      elements: [],
      transitions: [],
      logcat: []
    }
  };
  const shardHash = await writeJson(root, SHARD_PATH, shard);
  await writeJson(root, CONTEXT_PATH, {
    version: 2,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: [{
        path: "settings.gradle.kts",
        sha256: sha256(SETTINGS_CONTENT),
        confidence: "sourceConfirmed"
      }]
    },
    interactionPolicy: {
      allowedActions: ["click", "wait"],
      confirmationRequiredActions: [],
      forbiddenActions: []
    },
    modules: [{
      id: ":app",
      projectDir: "app",
      kind: "application",
      contextPath: SHARD_PATH,
      sha256: shardHash,
      features: ["launch"],
      activities: ["com.example.app.MainActivity"],
      dependsOn: [],
      status: "complete"
    }]
  });
  return { root };
}

async function twoSourceFixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-refresh-"));
  roots.push(root);
  await mkdir(join(root, dirname(APP_SOURCE)), { recursive: true });
  await writeFile(join(root, "settings.gradle.kts"), SETTINGS_CONTENT, "utf8");
  await writeFile(join(root, APP_SOURCE), APP_SOURCE_CONTENT, "utf8");
  await writeFile(join(root, HELPER_SOURCE), HELPER_SOURCE_CONTENT, "utf8");
  const inventoryPaths = [HELPER_SOURCE, APP_SOURCE].sort();
  const shard: ProjectContextModule = {
    version: 2,
    moduleId: ":app",
    projectDir: "app",
    status: "complete",
    inventory: {
      version: 2,
      pathSetSha256: sha256(inventoryPaths.join("\n")),
      categories: ["sources"]
    },
    manifest: {
      version: 1,
      files: [
        {
          path: APP_SOURCE,
          sha256: sha256(APP_SOURCE_CONTENT),
          confidence: "sourceConfirmed"
        },
        {
          path: HELPER_SOURCE,
          sha256: sha256(HELPER_SOURCE_CONTENT),
          confidence: "sourceConfirmed"
        }
      ]
    },
    summary: {
      features: ["launch"],
      activities: [{
        name: "com.example.app.MainActivity",
        entryPoints: [],
        screens: ["home"]
      }],
      elements: [],
      transitions: [],
      logcat: []
    }
  };
  const shardHash = await writeJson(root, SHARD_PATH, shard);
  await writeJson(root, CONTEXT_PATH, {
    version: 2,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: [{
        path: "settings.gradle.kts",
        sha256: sha256(SETTINGS_CONTENT),
        confidence: "sourceConfirmed"
      }]
    },
    interactionPolicy: {
      allowedActions: ["click", "wait"],
      confirmationRequiredActions: [],
      forbiddenActions: []
    },
    modules: [{
      id: ":app",
      projectDir: "app",
      kind: "application",
      contextPath: SHARD_PATH,
      sha256: shardHash,
      features: ["launch"],
      activities: ["com.example.app.MainActivity"],
      dependsOn: [],
      status: "complete"
    }]
  });
  return { root };
}

async function validate(root: string): Promise<string> {
  const loaded = await loader().load({
    projectRoot: root,
    contextPath: join(root, CONTEXT_PATH)
  });
  const result = await new ContextValidator(
    new NodeProjectFileInspector(),
    new NodeProjectInventoryInspector()
  ).validate({
    context: loaded.context,
    projectRoot: root,
    config
  });
  return result.status;
}

function evidenceOf(shard: unknown): {
  path: string;
  sha256: string;
  semanticSha256?: string;
} {
  const files = (shard as {
    manifest: {
      files: Array<{ path: string; sha256: string; semanticSha256?: string }>;
    };
  }).manifest.files;
  const first = files[0];
  if (first === undefined) {
    throw new Error("Missing evidence entry");
  }
  return first;
}

describe("ContextRefresher", () => {
  it("backfills semantic hashes and republishes shard and index hashes", async () => {
    const test = await fixture();

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(result.status).toBe("refreshed");
    expect(result.blocked).toEqual([]);
    expect(result.scopes).toEqual([
      expect.objectContaining({
        scope: "index",
        id: "index",
        written: true,
        semanticBackfilled: 1,
        formattingRehashed: 0
      }),
      expect.objectContaining({
        scope: "module",
        id: ":app",
        written: true,
        semanticBackfilled: 1,
        formattingRehashed: 0
      })
    ]);

    const evidence = evidenceOf(await readJson(test.root, SHARD_PATH));
    expect(evidence.semanticSha256).toMatch(/^[a-f\d]{64}$/);
    expect(evidence.sha256).toBe(sha256(APP_SOURCE_CONTENT));
    expect(await validate(test.root)).toBe("valid");

    const index = await readJson(test.root, CONTEXT_PATH) as {
      modules: Array<{ sha256: string }>;
    };
    const shardBytes = await readFile(join(test.root, SHARD_PATH), "utf8");
    expect(index.modules[0]?.sha256).toBe(sha256(shardBytes));
  });

  it("reports no work when semantic hashes are already current", async () => {
    const test = await fixture();
    await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(result.status).toBe("unchanged");
    expect(result.scopes.every((scope) => !scope.written)).toBe(true);
  });

  it("rehashes formatting-only changes without touching semantics", async () => {
    const test = await fixture();
    await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });
    await writeFile(
      join(test.root, APP_SOURCE),
      APP_SOURCE_CONTENT
        .replace("// opens search", "// opens the search screen")
        .replace("class MainActivity {", "class MainActivity  {\n"),
      "utf8"
    );

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(result.status).toBe("refreshed");
    expect(result.scopes).toContainEqual(expect.objectContaining({
      id: ":app",
      semanticBackfilled: 0,
      formattingRehashed: 1,
      semanticChanged: []
    }));
    expect(await validate(test.root)).toBe("valid");
  });

  it("blocks semantic changes unless they are accepted", async () => {
    const test = await fixture();
    await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });
    await writeFile(
      join(test.root, APP_SOURCE),
      APP_SOURCE_CONTENT.replace("fun open() = search()", "fun open() = home()"),
      "utf8"
    );
    const before = await readFile(join(test.root, SHARD_PATH), "utf8");

    const blocked = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked).toEqual([expect.objectContaining({
      code: "EVIDENCE_SEMANTIC_CHANGED",
      resolution: "acceptSourceChanges"
    })]);
    expect(await readFile(join(test.root, SHARD_PATH), "utf8")).toBe(before);
    expect(await validate(test.root)).toBe("stale");

    const accepted = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      acceptSourceChanges: true
    });

    expect(accepted.status).toBe("refreshed");
    expect(await validate(test.root)).toBe("valid");
  });

  it("blocks inventory drift until it is accepted", async () => {
    const test = await fixture();
    await writeFile(
      join(test.root, "app/src/main/java/com/example/app/Search.kt"),
      "class Search\n",
      "utf8"
    );

    const blocked = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked).toEqual([expect.objectContaining({
      code: "MODULE_INVENTORY_CHANGED",
      resolution: "acceptSourceChanges"
    })]);

    const accepted = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      acceptSourceChanges: true
    });

    expect(accepted.status).toBe("refreshed");
    expect(await validate(test.root)).toBe("valid");
  });

  it("blocks evidence that cannot be hashed", async () => {
    const test = await fixture();
    await rm(join(test.root, APP_SOURCE));

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      acceptSourceChanges: true
    });

    expect(result.status).toBe("blocked");
    expect(result.blocked).toEqual([expect.objectContaining({
      code: "EVIDENCE_UNRESOLVED",
      resolution: "pruneDeleted"
    })]);
  });

  it("prunes deleted evidence entries and accepts the inventory drift", async () => {
    const test = await twoSourceFixture();
    await rm(join(test.root, HELPER_SOURCE));

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      pruneDeleted: true,
      acceptSourceChanges: true
    });

    expect(result.status).toBe("refreshed");
    expect(result.blocked).toEqual([]);
    expect(result.scopes).toContainEqual(expect.objectContaining({
      id: ":app",
      pruned: 1,
      unresolved: [],
      inventoryChanged: true
    }));
    const shard = await readJson(test.root, SHARD_PATH) as {
      manifest: { files: Array<{ path: string }> };
    };
    expect(shard.manifest.files.map((file) => file.path)).toEqual([APP_SOURCE]);
    expect(await validate(test.root)).toBe("valid");
  });

  it("keeps deleted evidence blocked until prune-deleted is requested", async () => {
    const test = await twoSourceFixture();
    await rm(join(test.root, HELPER_SOURCE));

    const blocked = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      acceptSourceChanges: true
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked).toContainEqual(expect.objectContaining({
      code: "EVIDENCE_UNRESOLVED",
      resolution: "pruneDeleted"
    }));
    const shard = await readJson(test.root, SHARD_PATH) as {
      manifest: { files: Array<{ path: string }> };
    };
    expect(shard.manifest.files.map((file) => file.path)).toEqual([
      APP_SOURCE,
      HELPER_SOURCE
    ]);
  });

  it("refreshes only the requested modules", async () => {
    const test = await fixture();

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      moduleIds: [":app"]
    });

    expect(result.scopes.map((scope) => scope.id)).toEqual(["index", ":app"]);
    await expect(refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH),
      moduleIds: [":missing"]
    })).rejects.toThrow(ContextRefreshError);
  });

  it("repairs an index shard hash that drifted from disk", async () => {
    const test = await fixture();
    const index = await readJson(test.root, CONTEXT_PATH) as {
      modules: Array<{ sha256: string }>;
    };
    const reference = index.modules[0];
    if (reference === undefined) {
      throw new Error("Missing fixture module");
    }
    reference.sha256 = "0".repeat(64);
    await writeJson(test.root, CONTEXT_PATH, index);

    const result = await refresher().refresh({
      projectRoot: test.root,
      contextPath: join(test.root, CONTEXT_PATH)
    });

    expect(result.status).toBe("refreshed");
    expect(await validate(test.root)).toBe("valid");
  });
});
