import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ContextGenerateError,
  ContextGenerator,
  type ContextGeneratorDependencies
} from "../../../src/application/context/context-generator.js";
import type {
  ContextDocumentWrite
} from "../../../src/ports/context-document-writer.js";
import type {
  ProjectFileInspection
} from "../../../src/ports/project-file-inspector.js";
import type {
  ProjectIdentityInspection
} from "../../../src/ports/project-identity-inspector.js";
import type {
  ProjectInventoryInspection
} from "../../../src/ports/project-inventory-inspector.js";
import type {
  DiscoveredModule,
  ProjectModuleDiscovery
} from "../../../src/ports/project-module-discoverer.js";

const PROJECT_ROOT = "/tmp/taphound-test-project";
const CONTEXT_PATH = ".taphound/context/project-context.json";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function inspectedFile(path: string, content: string): ProjectFileInspection {
  return {
    status: "inspected",
    resolvedRelativePath: path,
    sha256: sha256(content),
    bytes: Buffer.from(content, "utf8")
  };
}

const APP_MODULE: DiscoveredModule = {
  id: ":app",
  projectDir: "app",
  kind: "application",
  dependsOn: []
};

const LIB_MODULE: DiscoveredModule = {
  id: ":lib",
  projectDir: "lib",
  kind: "library",
  dependsOn: []
};

const DEFAULT_DISCOVERY: ProjectModuleDiscovery = {
  status: "discovered",
  modules: [APP_MODULE]
};

const DEFAULT_IDENTITY: ProjectIdentityInspection = {
  status: "inspected",
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity"
};

const DEFAULT_INVENTORY: ProjectInventoryInspection = {
  status: "inspected",
  paths: ["app/src/main/AndroidManifest.xml"],
  pathSetSha256: "a".repeat(64)
};

const ROOT_EVIDENCE_FILES = [
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
  "gradle.properties",
  "gradle/libs.versions.toml"
];

class FakeEnvironment {
  public readonly writtenDocuments = new Map<string, unknown>();
  public readonly writtenOrder: string[] = [];
  private readonly fileContents = new Map<string, string>();
  private discoverResult: ProjectModuleDiscovery = DEFAULT_DISCOVERY;
  private identityResult: ProjectIdentityInspection = DEFAULT_IDENTITY;
  private readonly inventoryByDir = new Map<string, ProjectInventoryInspection>([
    ["app", DEFAULT_INVENTORY]
  ]);
  private readonly writerOverrides = new Map<string, ContextDocumentWrite>();

  public setFile(path: string, content: string): this {
    this.fileContents.set(path, content);
    return this;
  }

  public setDiscoverResult(result: ProjectModuleDiscovery): this {
    this.discoverResult = result;
    return this;
  }

  public setIdentityResult(result: ProjectIdentityInspection): this {
    this.identityResult = result;
    return this;
  }

  public setInventory(dir: string, result: ProjectInventoryInspection): this {
    this.inventoryByDir.set(dir, result);
    return this;
  }

  public setWriterOverride(relativePath: string, result: ContextDocumentWrite): this {
    this.writerOverrides.set(relativePath, result);
    return this;
  }

  public readonly buildDependencies = (): ContextGeneratorDependencies => ({
    discoverer: {
      discoverModules: () => Promise.resolve(this.discoverResult)
    },
    identity: {
      inspectIdentity: () => Promise.resolve(this.identityResult)
    },
    files: {
      inspectProjectFile: (input): Promise<ProjectFileInspection> => {
        const content = this.fileContents.get(input.relativePath);
        if (content === undefined) {
          return Promise.resolve<ProjectFileInspection>({ status: "notFound" });
        }
        return Promise.resolve(inspectedFile(input.relativePath, content));
      }
    },
    inventory: {
      inspectProjectInventory: (input): Promise<ProjectInventoryInspection> => {
        const result = this.inventoryByDir.get(input.projectDir);
        if (result === undefined) {
          return Promise.resolve<ProjectInventoryInspection>({ status: "rootNotFound" });
        }
        return Promise.resolve(result);
      }
    },
    writer: {
      writeContextDocument: (input): Promise<ContextDocumentWrite> => {
        const override = this.writerOverrides.get(input.relativePath);
        if (override !== undefined) {
          return Promise.resolve(override);
        }
        this.writtenDocuments.set(input.relativePath, input.document);
        this.writtenOrder.push(input.relativePath);
        return Promise.resolve<ContextDocumentWrite>({
          status: "written",
          sha256: sha256(`${input.relativePath}:${String(this.writtenOrder.length)}`)
        });
      }
    }
  });

  public generator(): ContextGenerator {
    return new ContextGenerator(this.buildDependencies());
  }
}

function standardEnvironment(): FakeEnvironment {
  const env = new FakeEnvironment();
  env.setFile("app/src/main/AndroidManifest.xml", "<manifest />");
  for (const path of ROOT_EVIDENCE_FILES) {
    env.setFile(path, "// content");
  }
  return env;
}

describe("ContextGenerator", () => {
  describe("successful generation", () => {
    it("generates a single application module with notAnalyzed shard and default policy", async () => {
      const env = standardEnvironment();
      const result = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.status).toBe("generated");
      expect(result.packageName).toBe("com.example.app");
      expect(result.launchActivity).toBe("com.example.app.MainActivity");
      expect(result.contextPath).toBe(CONTEXT_PATH);
      expect(result.indexHash).toMatch(/^[a-f\d]{64}$/);
      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]).toMatchObject({
        id: ":app",
        projectDir: "app",
        kind: "application",
        status: "notAnalyzed",
        evidenceCount: 1,
        contextPath: ".taphound/context/modules/app.json"
      });
      expect(result.modules[0]?.sha256).toMatch(/^[a-f\d]{64}$/);

      const shard = env.writtenDocuments.get(".taphound/context/modules/app.json") as {
        status: string;
        summary: Record<string, unknown[]>;
      };
      expect(shard.status).toBe("notAnalyzed");
      expect(shard.summary.features).toEqual([]);
      expect(shard.summary.activities).toEqual([]);
      expect(shard.summary.elements).toEqual([]);
      expect(shard.summary.transitions).toEqual([]);
      expect(shard.summary.logcat).toEqual([]);

      const index = env.writtenDocuments.get(CONTEXT_PATH) as {
        interactionPolicy: {
          allowedActions: string[];
          confirmationRequiredActions: string[];
          forbiddenActions: string[];
        };
      };
      expect(index.interactionPolicy).toEqual({
        allowedActions: ["click", "inputText", "back", "wait"],
        confirmationRequiredActions: [],
        forbiddenActions: []
      });
    });

    it("generates multiple modules sorted by id in the index", async () => {
      const env = standardEnvironment();
      env.setFile("lib/src/main/AndroidManifest.xml", "<manifest />");
      env.setDiscoverResult({
        status: "discovered",
        modules: [LIB_MODULE, APP_MODULE]
      });
      env.setInventory("lib", {
        status: "inspected",
        paths: ["lib/src/main/AndroidManifest.xml"],
        pathSetSha256: "b".repeat(64)
      });

      const result = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.modules.map((m) => m.id)).toEqual([":lib", ":app"]);

      const index = env.writtenDocuments.get(CONTEXT_PATH) as {
        modules: Array<{ id: string }>;
      };
      expect(index.modules.map((m) => m.id)).toEqual([":app", ":lib"]);
    });

    it("records dependsOn in module references", async () => {
      const env = standardEnvironment();
      env.setFile("lib/src/main/AndroidManifest.xml", "<manifest />");
      env.setDiscoverResult({
        status: "discovered",
        modules: [
          { ...APP_MODULE, dependsOn: [":lib"] },
          LIB_MODULE
        ]
      });
      env.setInventory("lib", {
        status: "inspected",
        paths: ["lib/src/main/AndroidManifest.xml"],
        pathSetSha256: "b".repeat(64)
      });

      await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      const index = env.writtenDocuments.get(CONTEXT_PATH) as {
        modules: Array<{ id: string; dependsOn: string[] }>;
      };
      const appRef = index.modules.find((m) => m.id === ":app");
      expect(appRef?.dependsOn).toEqual([":lib"]);
    });

    it("records evidenceCount for each module", async () => {
      const env = standardEnvironment();
      env.setFile("app/src/main/java/com/example/app/MainActivity.kt", "class MainActivity");
      env.setInventory("app", {
        status: "inspected",
        paths: [
          "app/src/main/AndroidManifest.xml",
          "app/src/main/java/com/example/app/MainActivity.kt"
        ],
        pathSetSha256: "c".repeat(64)
      });

      const result = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      expect(result.modules[0]?.evidenceCount).toBe(2);
    });

    it("writes inventory categories in each shard", async () => {
      const env = standardEnvironment();

      await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      const shard = env.writtenDocuments.get(".taphound/context/modules/app.json") as {
        inventory: { categories: string[] };
      };
      expect(shard.inventory.categories).toEqual([
        "manifests", "sources", "layouts", "navigation"
      ]);
    });

    it("collects root evidence from gradle files", async () => {
      const env = standardEnvironment();
      env.setFile("settings.gradle.kts", "include(\":app\")");
      env.setFile("gradle.properties", "org.gradle.jvmargs=-Xmx2g");
      env.setFile("build.gradle.kts", "plugins { }");

      await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      const index = env.writtenDocuments.get(CONTEXT_PATH) as {
        manifest: { files: Array<{ path: string }> };
      };
      const paths = index.manifest.files.map((f) => f.path);
      expect(paths).toContain("settings.gradle.kts");
      expect(paths).toContain("gradle.properties");
      expect(paths).toContain("build.gradle.kts");
    });

    it("writes semanticSha256 in evidence entries", async () => {
      const env = standardEnvironment();
      env.setFile("app/src/main/AndroidManifest.xml", "<manifest />");

      await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      const shard = env.writtenDocuments.get(".taphound/context/modules/app.json") as {
        manifest: {
          files: Array<{ semanticSha256: string; sha256: string }>;
        };
      };
      const evidence = shard.manifest.files[0];
      expect(evidence?.semanticSha256).toMatch(/^[a-f\d]{64}$/);
      expect(evidence?.sha256).not.toBe(evidence?.semanticSha256);
    });
  });

  describe("existing context", () => {
    it("rejects with CONTEXT_ALREADY_EXISTS without --force", async () => {
      const env = standardEnvironment();
      env.setFile(CONTEXT_PATH, "{}");

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({
        code: "CONTEXT_ALREADY_EXISTS"
      });
    });

    it("overwrites existing context with --force", async () => {
      const env = standardEnvironment();
      env.setFile(CONTEXT_PATH, "{}");

      const result = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH,
        force: true
      });

      expect(result.status).toBe("generated");
    });
  });

  describe("module discovery failures", () => {
    it("fails with MODULE_DISCOVERY_FAILED on rootNotFound", async () => {
      const env = standardEnvironment();
      env.setDiscoverResult({ status: "rootNotFound" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "MODULE_DISCOVERY_FAILED" });
    });

    it("fails with MODULE_DISCOVERY_FAILED on noSettingsFile", async () => {
      const env = standardEnvironment();
      env.setDiscoverResult({ status: "noSettingsFile" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "MODULE_DISCOVERY_FAILED" });
    });

    it("fails with MODULE_DISCOVERY_FAILED on noApplicationModule", async () => {
      const env = standardEnvironment();
      env.setDiscoverResult({ status: "noApplicationModule" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "MODULE_DISCOVERY_FAILED" });
    });

    it("fails with MODULE_DISCOVERY_FAILED when no application kind module exists", async () => {
      const env = standardEnvironment();
      env.setFile("lib/src/main/AndroidManifest.xml", "<manifest />");
      env.setDiscoverResult({
        status: "discovered",
        modules: [LIB_MODULE]
      });
      env.setInventory("lib", {
        status: "inspected",
        paths: ["lib/src/main/AndroidManifest.xml"],
        pathSetSha256: "b".repeat(64)
      });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "MODULE_DISCOVERY_FAILED" });
    });

    it("fails with MODULE_DISCOVERY_FAILED on inventory inspection failure", async () => {
      const env = standardEnvironment();
      env.setInventory("app", { status: "rootNotFound" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "MODULE_DISCOVERY_FAILED" });
    });
  });

  describe("identity inspection failures", () => {
    it("fails with IDENTITY_INSPECTION_FAILED on rootNotFound", async () => {
      const env = standardEnvironment();
      env.setIdentityResult({ status: "rootNotFound" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "IDENTITY_INSPECTION_FAILED" });
    });

    it("fails with IDENTITY_INSPECTION_FAILED on manifestNotFound", async () => {
      const env = standardEnvironment();
      env.setIdentityResult({ status: "manifestNotFound" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "IDENTITY_INSPECTION_FAILED" });
    });

    it("fails with IDENTITY_INSPECTION_FAILED on identityNotFound", async () => {
      const env = standardEnvironment();
      env.setIdentityResult({ status: "identityNotFound", message: "no app id" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "IDENTITY_INSPECTION_FAILED" });
    });
  });

  describe("evidence failures", () => {
    it("fails with NO_EVIDENCE when inventory returns empty paths", async () => {
      const env = standardEnvironment();
      env.setInventory("app", {
        status: "inspected",
        paths: [],
        pathSetSha256: "0".repeat(64)
      });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    });

    it("fails with NO_EVIDENCE when all evidence files are missing", async () => {
      const env = new FakeEnvironment();
      env.setInventory("app", {
        status: "inspected",
        paths: ["app/src/main/AndroidManifest.xml"],
        pathSetSha256: "a".repeat(64)
      });
      for (const path of ROOT_EVIDENCE_FILES) {
        env.setFile(path, "// content");
      }

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    });

    it("fails with NO_EVIDENCE when no root evidence files exist", async () => {
      const env = new FakeEnvironment();
      env.setFile("app/src/main/AndroidManifest.xml", "<manifest />");

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "NO_EVIDENCE" });
    });
  });

  describe("write failures", () => {
    it("fails with CONTEXT_WRITE_FAILED on escape", async () => {
      const env = standardEnvironment();
      env.setWriterOverride(".taphound/context/modules/app.json", { status: "escape" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
    });

    it("fails with CONTEXT_WRITE_FAILED on unwritable with message", async () => {
      const env = standardEnvironment();
      env.setWriterOverride(".taphound/context/modules/app.json", {
        status: "unwritable",
        message: "disk full"
      });

      const error = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ContextGenerateError);
      expect((error as ContextGenerateError).code).toBe("CONTEXT_WRITE_FAILED");
      expect((error as ContextGenerateError).message).toContain("disk full");
    });

    it("fails with CONTEXT_WRITE_FAILED on index write escape", async () => {
      const env = standardEnvironment();
      env.setWriterOverride(CONTEXT_PATH, { status: "escape" });

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      })).rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
    });
  });

  describe("path validation", () => {
    it("rejects contextPath outside project with CONTEXT_INVALID", async () => {
      const env = standardEnvironment();

      await expect(env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: "../../../etc/passwd"
      })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    });

    it("accepts absolute contextPath within project", async () => {
      const env = standardEnvironment();

      const result = await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: `${PROJECT_ROOT}/${CONTEXT_PATH}`
      });

      expect(result.status).toBe("generated");
      expect(result.contextPath).toBe(CONTEXT_PATH);
    });
  });

  describe("write order", () => {
    it("writes shards before the index", async () => {
      const env = standardEnvironment();
      env.setFile("lib/src/main/AndroidManifest.xml", "<manifest />");
      env.setDiscoverResult({
        status: "discovered",
        modules: [APP_MODULE, LIB_MODULE]
      });
      env.setInventory("lib", {
        status: "inspected",
        paths: ["lib/src/main/AndroidManifest.xml"],
        pathSetSha256: "b".repeat(64)
      });

      await env.generator().generate({
        projectRoot: PROJECT_ROOT,
        contextPath: CONTEXT_PATH
      });

      const lastIndex = env.writtenOrder.length - 1;
      expect(env.writtenOrder[lastIndex]).toBe(CONTEXT_PATH);
      expect(env.writtenOrder.slice(0, -1)).toContain(".taphound/context/modules/app.json");
      expect(env.writtenOrder.slice(0, -1)).toContain(".taphound/context/modules/lib.json");
    });
  });
});
