import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextValidator,
  MAX_CONTEXT_EVIDENCE_BYTES
} from "../../../src/application/context/context-validator.js";
import { semanticSha256 } from "../../../src/application/context/evidence-hash.js";
import { NodeProjectFileInspector } from "../../../src/adapters/filesystem/project-file-inspector.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";
import type { ProjectFileInspector } from "../../../src/ports/project-file-inspector.js";
import type {
  ProjectInventoryInspector
} from "../../../src/ports/project-inventory-inspector.js";

const temporaryRoots: string[] = [];

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

const policy = {
  allowedActions: ["click", "inputText", "back", "wait"],
  confirmationRequiredActions: ["back"],
  forbiddenActions: ["longClick", "swipe", "scrollTo"]
};

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function contextFor(
  files: Array<{
    path: string;
    sha256: string;
    semanticSha256?: string;
    confidence?: unknown;
  }>
): unknown {
  return {
    version: 2,
    packageName: config.run.packageName,
    launchActivity: "com.example.app.MainActivity",
    manifest: {
      version: 1,
      files: files.map((file) => ({
        ...file,
        confidence: file.confidence ?? "sourceConfirmed"
      }))
    },
    interactionPolicy: policy,
    selection: {
      bundleVersion: 2,
      indexHash: "f".repeat(64),
      modules: [{
        id: ":app",
        sha256: "e".repeat(64),
        projectDir: "app",
        inventory: {
          pathSetSha256: "c".repeat(64),
          categories: ["manifests", "sources", "layouts", "navigation"]
        }
      }]
    }
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-context-test-"));
  temporaryRoots.push(root);
  return root;
}

async function writeEvidence(
  root: string,
  relativePath: string,
  content: string | Uint8Array
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function validator(): ContextValidator {
  return new ContextValidator(new NodeProjectFileInspector());
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("ContextValidator", () => {
  it("accepts matching project-relative evidence without interpreting its semantics", async () => {
    const root = await temporaryRoot();
    const content = "<manifest package=\"not-semantic-proof\" />";
    const path = "app/src/main/AndroidManifest.xml";
    await writeEvidence(root, path, content);

    await expect(validator().validate({
      context: contextFor([{ path, sha256: sha256(content) }]),
      projectRoot: root,
      config
    })).resolves.toEqual({ status: "valid" });
  });

  it("reports stale when declared project evidence changed", async () => {
    const root = await temporaryRoot();
    const path = "app/src/main/source.kt";
    await writeEvidence(root, path, "current content");

    await expect(validator().validate({
      context: contextFor([{ path, sha256: sha256("old content") }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "stale",
      reason: {
        code: "EVIDENCE_HASH_MISMATCH",
        message: "Evidence file changed: app/src/main/source.kt"
      }
    });
  });

  it("ignores formatting-only changes when semantic evidence matches", async () => {
    const root = await temporaryRoot();
    const path = "app/src/main/source.kt";
    const semantic = "fun render() { Text(\"Chat\") }";
    await writeEvidence(root, path, semantic);

    const context = contextFor([{
      path,
      sha256: sha256("old formatting"),
      semanticSha256: semanticSha256(semantic)
    }]);
    await writeEvidence(root, path, "fun render(){\n  Text(\"Chat\")\n}\n");

    await expect(validator().validate({
      context,
      projectRoot: root,
      config
    })).resolves.toEqual({ status: "valid" });
  });

  it("reports stale when semantic evidence changes", async () => {
    const root = await temporaryRoot();
    const path = "app/src/main/source.kt";
    await writeEvidence(root, path, "fun render() { Text(\"Changed\") }");

    await expect(validator().validate({
      context: contextFor([{
        path,
        sha256: sha256("old content"),
        semanticSha256: semanticSha256(
          "fun render() { Text(\"Original\") }"
        )
      }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "stale",
      reason: {
        code: "EVIDENCE_HASH_MISMATCH",
        message: "Semantic evidence changed: app/src/main/source.kt"
      }
    });
  });

  it("prioritizes invalid unreadable evidence over an earlier stale hash", async () => {
    const root = await temporaryRoot();
    await writeEvidence(root, "changed.kt", "current content");

    await expect(validator().validate({
      context: contextFor([
        { path: "changed.kt", sha256: sha256("old content") },
        { path: "missing.kt", sha256: "a".repeat(64) }
      ]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_NOT_FOUND",
        message: "Evidence file does not exist: missing.kt"
      }
    });
  });

  it("rejects missing evidence as invalid", async () => {
    const root = await temporaryRoot();

    await expect(validator().validate({
      context: contextFor([{
        path: "app/src/main/missing.kt",
        sha256: "a".repeat(64)
      }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_NOT_FOUND",
        message: "Evidence file does not exist: app/src/main/missing.kt"
      }
    });
  });

  it("rejects a project root that is not a directory", async () => {
    const root = await temporaryRoot();
    const projectFile = join(root, "project.txt");
    await writeFile(projectFile, "not a directory");

    await expect(validator().validate({
      context: contextFor([{
        path: "source.kt",
        sha256: "a".repeat(64)
      }]),
      projectRoot: projectFile,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "PROJECT_ROOT_NOT_DIRECTORY",
        message: "Project root is not a directory"
      }
    });
  });

  it.each([
    "/tmp/outside.kt",
    "../outside.kt",
    String.raw`..\outside.kt`,
    String.raw`C:\outside.kt`,
    String.raw`\\server\share\outside.kt`
  ])("rejects absolute and traversal evidence path %s", async (path) => {
    const root = await temporaryRoot();

    const result = await validator().validate({
      context: contextFor([{ path, sha256: "a".repeat(64) }]),
      projectRoot: root,
      config
    });

    expect(result).toEqual({
      status: "invalid",
      reason: {
        code: "CONTEXT_SCHEMA_INVALID",
        message: "Resolved Project Context does not match the version 2 schema"
      }
    });
  });

  it("rejects evidence symlinks that resolve outside the real project root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const outsideFile = join(outside, "outside.kt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(root, "linked.kt"));

    await expect(validator().validate({
      context: contextFor([{
        path: "linked.kt",
        sha256: sha256("outside")
      }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_PATH_ESCAPE",
        message: "Evidence file resolves outside the project: linked.kt"
      }
    });
  });

  it.each([
    ".env",
    ".envrc",
    ".env.production",
    ".secrets/token.txt",
    ".credentials/config",
    "android/keystore.properties",
    "local.properties",
    "credentials.json",
    "credentials.yaml",
    "service-account.json",
    "signing/release.keystore",
    "keys/id_rsa",
    "keys/private.pem"
  ])("rejects secret evidence path %s", async (path) => {
    const root = await temporaryRoot();
    const content = "secret";
    await writeEvidence(root, path, content);

    await expect(validator().validate({
      context: contextFor([{ path, sha256: sha256(content) }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_SECRET_PATH",
        message: `Secret files cannot be context evidence: ${path}`
      }
    });
  });

  it("rejects a benign evidence alias that resolves to a secret file", async () => {
    const root = await temporaryRoot();
    const content = "secret";
    await writeEvidence(root, ".env", content);
    await symlink(join(root, ".env"), join(root, "source.txt"));

    await expect(validator().validate({
      context: contextFor([{
        path: "source.txt",
        sha256: sha256(content)
      }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_SECRET_PATH",
        message: "Secret files cannot be context evidence: source.txt"
      }
    });
  });

  it("maps changed file identity from the secure inspection boundary", async () => {
    const files: ProjectFileInspector = {
      inspectProjectFile: vi.fn(() => Promise.resolve({
        status: "changedIdentity" as const
      }))
    };

    await expect(new ContextValidator(files).validate({
      context: contextFor([{
        path: "source.kt",
        sha256: "a".repeat(64)
      }]),
      projectRoot: "/project",
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_CHANGED_IDENTITY",
        message: "Evidence file changed during inspection: source.kt"
      }
    });
  });

  it("detects a module inventory change during revalidation", async () => {
    const files: ProjectFileInspector = {
      inspectProjectFile: vi.fn(() => Promise.resolve({
        status: "inspected" as const,
        resolvedRelativePath: "source.kt",
        sha256: "a".repeat(64)
      }))
    };
    const inventory: ProjectInventoryInspector = {
      inspectProjectInventory: vi.fn(() => Promise.resolve({
        status: "inspected" as const,
        paths: ["app/src/main/New.kt"],
        pathSetSha256: "b".repeat(64)
      }))
    };

    await expect(new ContextValidator(files, inventory).validate({
      context: contextFor([{
        path: "source.kt",
        sha256: "a".repeat(64)
      }]),
      projectRoot: "/project",
      config
    })).resolves.toEqual({
      status: "stale",
      reason: {
        code: "EVIDENCE_HASH_MISMATCH",
        message: "Module file inventory changed: :app"
      }
    });
  });

  it("rejects evidence larger than the explicit maximum", async () => {
    const root = await temporaryRoot();
    const path = "app/src/main/large.txt";
    const content = new Uint8Array(MAX_CONTEXT_EVIDENCE_BYTES + 1);
    await writeEvidence(root, path, content);

    await expect(validator().validate({
      context: contextFor([{ path, sha256: sha256(content) }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "EVIDENCE_TOO_LARGE",
        message: `Evidence file exceeds ${String(MAX_CONTEXT_EVIDENCE_BYTES)} bytes: ${path}`
      }
    });
  });

  it("rejects malformed context and out-of-contract confidence values", async () => {
    const root = await temporaryRoot();

    await expect(validator().validate({
      context: contextFor([{
        path: "source.kt",
        sha256: "a".repeat(64),
        confidence: "high"
      }]),
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "CONTEXT_SCHEMA_INVALID",
        message: "Resolved Project Context does not match the version 2 schema"
      }
    });
  });

  it.each([
    {
      packageName: "com.other.app",
      activity: config.run.activity
    },
    {
      packageName: config.run.packageName,
      activity: ".OtherActivity"
    }
  ])("rejects project/config identity mismatch", async (mismatchedRun) => {
    const root = await temporaryRoot();

    await expect(validator().validate({
      context: contextFor([{
        path: "source.kt",
        sha256: "a".repeat(64)
      }]),
      projectRoot: root,
      config: {
        ...config,
        run: mismatchedRun
      }
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "CONTEXT_IDENTITY_MISMATCH",
        message: "Project Context identity does not match the configured project"
      }
    });
  });
});
