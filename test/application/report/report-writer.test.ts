import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemArtifactStore } from "../../../src/adapters/filesystem/artifact-store.js";
import {
  logcatEvidenceWarning,
  ReportWriter
} from "../../../src/application/report/report-writer.js";
import { validReport } from "../../fixtures/report.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taphound-report-test-"));
  roots.push(root);
  return root;
}

describe("logcatEvidenceWarning", () => {
  it("names dropped Logcat lines across device roles", () => {
    expect(logcatEvidenceWarning({})).toBeUndefined();
    expect(logcatEvidenceWarning({
      logcatEvidence: [
        { role: "default", droppedLines: 1883, droppedBytes: 274880, status: "incomplete" },
        { role: "receiver", droppedLines: 17, droppedBytes: 900, status: "incomplete" }
      ]
    })).toBe(
      "Warning: Logcat evidence is incomplete (1900 line(s) dropped); "
        + "Logcat-based expectations fail closed on drops in their window"
    );
  });

  it("adds the warning to the published summary", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-logcat");
    const report = validReport({
      artifacts: { ...validReport().artifacts, directory: session.finalDirectory },
      logcatEvidence: [
        { role: "default", droppedLines: 3, droppedBytes: 90, status: "incomplete" }
      ]
    });

    const published = await new ReportWriter().writeAndPublish(session, report);

    await expect(readFile(published.summaryPath, "utf8"))
      .resolves.toContain("Warning: Logcat evidence is incomplete (3 line(s) dropped)");
  });
});

describe("ReportWriter", () => {
  it("writes JSON and human summary before publishing", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-123");
    await session.writeText("logcat.txt", "logs");
    const report = validReport({
      artifacts: {
        ...validReport().artifacts,
        directory: session.finalDirectory
      }
    });

    const result = await new ReportWriter().writeAndPublish(session, report);

    expect(result.directory).toBe(join(root, "run-123"));
    await expect(readFile(join(result.directory, "report.json"), "utf8"))
      .resolves.toContain('"schemaVersion": 4');
    await expect(readFile(join(result.directory, "summary.txt"), "utf8"))
      .resolves.toContain("TapHound run run-123: PASSED");
    await expect(readFile(join(result.directory, "summary.txt"), "utf8"))
      .resolves.toContain("Device[default]: emulator-5554");
  });

  it("includes primary and secondary failures in the summary", async () => {
    const root = await temporaryRoot();
    const session = await new FileSystemArtifactStore().begin(root, "run-failed");
    const report = validReport({
      runId: "run-failed",
      status: "failed",
      artifacts: {
        ...validReport().artifacts,
        directory: session.finalDirectory
      },
      primaryFailure: {
        code: "LOCATOR_NOT_FOUND",
        message: "missing",
        phase: "replay",
        stepIndex: 0
      },
      secondaryErrors: [{
        code: "COLLECTION_FAILED",
        message: "screenshot missing",
        phase: "collection"
      }]
    });

    const result = await new ReportWriter().writeAndPublish(session, report);
    const summary = await readFile(join(result.directory, "summary.txt"), "utf8");

    expect(summary).toContain("LOCATOR_NOT_FOUND: missing");
    expect(summary).toContain("COLLECTION_FAILED: screenshot missing");
  });
});
