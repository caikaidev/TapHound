import { describe, expect, it } from "vitest";

import {
  ContextRehashError,
  ContextRehasher,
  type ContextRehasherDependencies
} from "../../../src/application/context/context-rehasher.js";
import type {
  ContextDocumentWrite,
  ContextDocumentWriter
} from "../../../src/ports/context-document-writer.js";
import type {
  ProjectFileInspection,
  ProjectFileInspector
} from "../../../src/ports/project-file-inspector.js";
import type {
  ContextModuleReference,
  ProjectContext,
  ProjectContextModule
} from "../../../src/domain/project-context.js";

const PROJECT_ROOT = "/tmp/taphound-rehash-project";
const CONTEXT_PATH = ".taphound/context/project-context.json";
const SHARD_PATH_APP = ".taphound/context/modules/app.json";
const SHARD_PATH_LIB = ".taphound/context/modules/lib.json";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeShard(
  overrides: Partial<ProjectContextModule> = {}
): ProjectContextModule {
  return {
    version: 2,
    moduleId: ":app",
    projectDir: "app",
    status: "complete",
    inventory: {
      version: 2,
      pathSetSha256: HASH_A,
      categories: ["manifests", "sources", "layouts", "navigation"]
    },
    manifest: {
      version: 1,
      files: [{
        path: "app/src/main/AndroidManifest.xml",
        sha256: HASH_A,
        semanticSha256: HASH_A,
        confidence: "sourceConfirmed"
      }]
    },
    summary: {
      features: [],
      activities: [],
      elements: [],
      transitions: [],
      logcat: []
    },
    ...overrides
  };
}

function makeReference(
  overrides: Partial<ContextModuleReference> = {}
): ContextModuleReference {
  return {
    id: ":app",
    projectDir: "app",
    kind: "application",
    contextPath: SHARD_PATH_APP,
    sha256: HASH_A,
    features: [],
    activities: [],
    dependsOn: [],
    status: "complete",
    ...overrides
  };
}

function makeBundle(
  modules: ContextModuleReference[] = [makeReference()]
): ProjectContext {
  return {
    version: 2,
    packageName: "com.example.app",
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: [{
        path: "settings.gradle.kts",
        sha256: HASH_A,
        semanticSha256: HASH_A,
        confidence: "sourceConfirmed"
      }]
    },
    interactionPolicy: {
      allowedActions: ["click", "wait"],
      confirmationRequiredActions: [],
      forbiddenActions: []
    },
    modules
  };
}

interface InspectedShardFile {
  readonly status: "inspected";
  readonly resolvedRelativePath: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

function inspectedShard(
  shard: ProjectContextModule,
  overrides: { resolvedRelativePath?: string; sha256?: string } = {}
): InspectedShardFile {
  const content = `${JSON.stringify(shard, null, 2)}\n`;
  return {
    status: "inspected",
    resolvedRelativePath: overrides.resolvedRelativePath ?? SHARD_PATH_APP,
    sha256: overrides.sha256 ?? HASH_A,
    bytes: Buffer.from(content, "utf8")
  };
}

function inspectedFile(
  resolvedRelativePath: string,
  sha256: string,
  bytes: Buffer
): InspectedShardFile {
  return { status: "inspected", resolvedRelativePath, sha256, bytes };
}

type ShardInspection = InspectedShardFile | { readonly status: "notFound" };

interface FakeRehashEnvironment {
  readonly dependencies: ContextRehasherDependencies;
  readonly writtenDocuments: Map<string, unknown>;
}

function makeEnvironment(options: {
  readonly bundle?: ProjectContext;
  readonly indexHash?: string;
  readonly shardInspections?: Record<string, ShardInspection>;
  readonly writerOverride?: ContextDocumentWrite;
  readonly writerSha256?: string;
} = {}): FakeRehashEnvironment {
  const bundle = options.bundle ?? makeBundle();
  const indexHash = options.indexHash ?? HASH_A;
  const shardInspections: Record<string, ShardInspection> = options.shardInspections ?? {};
  const writtenDocuments = new Map<string, unknown>();

  const files: ProjectFileInspector = {
    inspectProjectFile: (input) => {
      const result = shardInspections[input.relativePath];
      if (result === undefined) {
        return Promise.resolve<ProjectFileInspection>({ status: "notFound" });
      }
      return Promise.resolve<ProjectFileInspection>(result);
    }
  };

  const writer: ContextDocumentWriter = {
    writeContextDocument: (input) => {
      if (options.writerOverride !== undefined) {
        return Promise.resolve(options.writerOverride);
      }
      writtenDocuments.set(input.relativePath, input.document);
      return Promise.resolve<ContextDocumentWrite>({
        status: "written",
        sha256: options.writerSha256 ?? HASH_B
      });
    }
  };

  const dependencies: ContextRehasherDependencies = {
    files,
    loader: {
      readIndex: () => Promise.resolve({ bundle, indexHash })
    },
    writer
  };

  return { dependencies, writtenDocuments };
}

describe("ContextRehasher", () => {
  describe("rehash", () => {
    it("returns unchanged when no shard hashes changed", async () => {
      const shard = makeShard();
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ sha256: HASH_A })]),
        indexHash: HASH_A,
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(shard)
        }
      });

      const result = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.status).toBe("unchanged");
      expect(result.previousIndexHash).toBe(HASH_A);
      expect(result.indexHash).toBe(HASH_A);
      expect(result.modules).toEqual([{
        id: ":app",
        previousSha256: HASH_A,
        currentSha256: HASH_A,
        changed: false
      }]);
      expect(env.writtenDocuments.size).toBe(0);
    });

    it("returns rehashed with updated index hash when a shard changed", async () => {
      const shard = makeShard();
      const newShardHash = "c".repeat(64);
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ sha256: HASH_A })]),
        indexHash: HASH_A,
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(shard, { sha256: newShardHash })
        },
        writerSha256: HASH_B
      });

      const result = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.status).toBe("rehashed");
      expect(result.previousIndexHash).toBe(HASH_A);
      expect(result.indexHash).toBe(HASH_B);
      expect(result.modules).toEqual([{
        id: ":app",
        previousSha256: HASH_A,
        currentSha256: newShardHash,
        changed: true
      }]);

      const written = env.writtenDocuments.get(CONTEXT_PATH) as {
        modules: Array<{ sha256: string }>;
      };
      expect(written.modules[0]?.sha256).toBe(newShardHash);
    });

    it("updates only changed module references in the index", async () => {
      const appShard = makeShard({ moduleId: ":app" });
      const libShard = makeShard({
        moduleId: ":lib",
        projectDir: "lib"
      });
      const appNewHash = "c".repeat(64);
      const libHash = HASH_A;

      const env = makeEnvironment({
        bundle: makeBundle([
          makeReference({ id: ":app", sha256: HASH_A }),
          makeReference({
            id: ":lib",
            projectDir: "lib",
            kind: "library",
            contextPath: SHARD_PATH_LIB,
            sha256: libHash
          })
        ]),
        indexHash: HASH_A,
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(appShard, { sha256: appNewHash }),
          [SHARD_PATH_LIB]: inspectedShard(libShard, {
            resolvedRelativePath: SHARD_PATH_LIB,
            sha256: libHash
          })
        },
        writerSha256: HASH_B
      });

      const result = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.status).toBe("rehashed");
      const written = env.writtenDocuments.get(CONTEXT_PATH) as {
        modules: Array<{ id: string; sha256: string }>;
      };
      const appRef = written.modules.find((m) => m.id === ":app");
      const libRef = written.modules.find((m) => m.id === ":lib");
      expect(appRef?.sha256).toBe(appNewHash);
      expect(libRef?.sha256).toBe(libHash);
    });

    it("processes only requested moduleIds when specified", async () => {
      const appShard = makeShard({ moduleId: ":app" });
      const libShard = makeShard({
        moduleId: ":lib",
        projectDir: "lib"
      });
      const appNewHash = "c".repeat(64);

      const env = makeEnvironment({
        bundle: makeBundle([
          makeReference({ id: ":app", sha256: HASH_A }),
          makeReference({
            id: ":lib",
            projectDir: "lib",
            kind: "library",
            contextPath: SHARD_PATH_LIB,
            sha256: HASH_A
          })
        ]),
        indexHash: HASH_A,
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(appShard, { sha256: appNewHash }),
          [SHARD_PATH_LIB]: inspectedShard(libShard, {
            resolvedRelativePath: SHARD_PATH_LIB,
            sha256: "d".repeat(64)
          })
        },
        writerSha256: HASH_B
      });

      const result = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH,
        moduleIds: [":app"]
      });

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]?.id).toBe(":app");
      expect(result.status).toBe("rehashed");
    });

    it("processes all modules when moduleIds is empty", async () => {
      const shard = makeShard();

      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ sha256: HASH_A })]),
        indexHash: HASH_A,
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(shard)
        }
      });

      const result = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH,
        moduleIds: []
      });

      expect(result.modules).toHaveLength(1);
      expect(result.status).toBe("unchanged");
    });
  });

  describe("failure paths", () => {
    it("fails with CONTEXT_INVALID when contextPath escapes project", async () => {
      const env = makeEnvironment();

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: "../../../etc/passwd"
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_INVALID when shard file is not found", async () => {
      const env = makeEnvironment({
        bundle: makeBundle([makeReference()]),
        shardInspections: {}
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_INVALID when shard is invalid JSON", async () => {
      const env = makeEnvironment({
        bundle: makeBundle([makeReference()]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedFile(
            SHARD_PATH_APP,
            HASH_A,
            Buffer.from("{ invalid json", "utf8")
          )
        }
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_INVALID when shard does not match schema", async () => {
      const env = makeEnvironment({
        bundle: makeBundle([makeReference()]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedFile(
            SHARD_PATH_APP,
            HASH_A,
            Buffer.from(
              JSON.stringify({ version: 99, moduleId: ":app" }),
              "utf8"
            )
          )
        }
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_INVALID when shard identity does not match index", async () => {
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ id: ":app", projectDir: "app" })]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(
            makeShard({ moduleId: ":different" })
          )
        }
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_INVALID when shard status does not match index", async () => {
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ status: "complete" })]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(
            makeShard({ status: "notAnalyzed" })
          )
        }
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("fails with CONTEXT_WRITE_FAILED on writer escape", async () => {
      const shard = makeShard();
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ sha256: HASH_A })]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(shard, { sha256: "c".repeat(64) })
        },
        writerOverride: { status: "escape" }
      });

      await expect(new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
    });

    it("fails with CONTEXT_WRITE_FAILED on writer unwritable", async () => {
      const shard = makeShard();
      const env = makeEnvironment({
        bundle: makeBundle([makeReference({ sha256: HASH_A })]),
        shardInspections: {
          [SHARD_PATH_APP]: inspectedShard(shard, { sha256: "c".repeat(64) })
        },
        writerOverride: { status: "unwritable", message: "read-only" }
      });

      const error = await new ContextRehasher(env.dependencies).rehash({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ContextRehashError);
      expect((error as ContextRehashError).code).toBe("CONTEXT_WRITE_FAILED");
      expect((error as ContextRehashError).message).toContain("read-only");
    });
  });
});
