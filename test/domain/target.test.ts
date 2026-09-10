import { describe, expect, it } from "vitest";

import {
  AndroidProjectIdentitySchema,
  LocalTargetIdentitySchema,
  ProjectFingerprintSchema,
  TargetsFileSchema,
  TargetError
} from "../../src/domain/target.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";

describe("target domain", () => {
  it("parses a targets file with a local target", () => {
    const parsed = TargetsFileSchema.parse({
      version: 1,
      targets: {
        "work-app": {
          source: { type: "local", path: "${TAPHOUND_WORK_APP}" },
          run: { packageName: "com.example.app", activity: ".MainActivity" },
          git: { enabled: true }
        }
      }
    });
    expect(parsed.targets["work-app"]).toBeDefined();
    const workApp = parsed.targets["work-app"];
    if (workApp === undefined) {
      throw new Error("missing work-app target");
    }
    expect(workApp.run.packageName).toBe("com.example.app");
    expect(workApp.run.activity).toBe(".MainActivity");
  });

  it("defaults activity and git.enabled", () => {
    const parsed = TargetsFileSchema.parse({
      version: 1,
      targets: {
        app: {
          source: { type: "local", path: "/tmp/app" },
          run: { packageName: "com.example.app" }
        }
      }
    });
    expect(parsed.targets.app).toBeDefined();
    const appTarget = parsed.targets.app;
    if (appTarget === undefined) {
      throw new Error("missing app target");
    }
    expect(appTarget.run.activity).toBe(".MainActivity");
    expect(appTarget.git.enabled).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(() => TargetsFileSchema.parse({
      version: 1,
      targets: {
        app: {
          source: { type: "local", path: "/tmp/app" },
          run: { packageName: "com.example.app" },
          nope: true
        }
      }
    })).toThrow();
  });

  it("validates the AndroidProjectIdentity contract", () => {
    expect(() => AndroidProjectIdentitySchema.parse({
      rootDir: "/x", settingsFile: "/x/settings.gradle.kts"
    })).not.toThrow();
    expect(() => AndroidProjectIdentitySchema.parse({
      rootDir: "/x"
    })).toThrow();
  });

  it("parses and round-trips fingerprint and identity documents", () => {
    const fingerprint = ProjectFingerprintSchema.parse({
      schemaVersion: 1,
      hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      gitRemote: "git@github.com:acme/mail.git",
      rootProjectName: "MailApp",
      packageName: "com.example.mail"
    });
    expect(fingerprint.hash).toHaveLength(64);
    expect(() => LocalTargetIdentitySchema.parse({
      schemaVersion: 1,
      targetId: "work-app",
      sourceType: "local",
      configuredPath: "${TAPHOUND_WORK_APP}",
      resolvedPath: "/Users/alice/Projects/MailApp",
      fingerprint,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z"
    })).not.toThrow();
  });

  it("TargetError carries a registered failure code", () => {
    const error = new TargetError("LOCAL_TARGET_ENV_MISSING", "boom");
    expect(FAILURE_CODES).toContain(error.code);
    expect(error.message).toBe("boom");
  });
});