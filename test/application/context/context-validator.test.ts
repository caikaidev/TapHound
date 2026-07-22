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

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextValidator,
  MAX_CONTEXT_EVIDENCE_BYTES
} from "../../../src/application/context/context-validator.js";
import { NodeProjectFileInspector } from "../../../src/adapters/filesystem/project-file-inspector.js";
import type { TapHoundConfig } from "../../../src/domain/config.js";

const temporaryRoots: string[] = [];

const config: TapHoundConfig = {
  version: 1,
  build: { task: "assembleDebug" },
  artifact: { target: "app", variant: "debug" },
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
  files: Array<{ path: string; sha256: string }>
): unknown {
  return {
    version: 1,
    packageName: config.run.packageName,
    launchActivity: "com.example.app.MainActivity",
    manifest: { version: 1, files },
    interactionPolicy: policy
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
        message: "Project Context does not match the version 1 schema"
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
    ".env.production",
    "credentials.json",
    "signing/release.keystore",
    "keys/id_rsa"
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
      context: {
        ...(contextFor([{
          path: "source.kt",
          sha256: "a".repeat(64)
        }]) as object),
        confidence: 1.1
      },
      projectRoot: root,
      config
    })).resolves.toEqual({
      status: "invalid",
      reason: {
        code: "CONTEXT_SCHEMA_INVALID",
        message: "Project Context does not match the version 1 schema"
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
