import { join } from "node:path";

import {
  TapHoundReportSchema,
  type TapHoundReport
} from "../../domain/report.js";
import type { ArtifactSession } from "../../ports/artifact-store.js";

export interface PublishedReport {
  directory: string;
  reportPath: string;
  summaryPath: string;
}

/**
 * One line naming dropped Logcat evidence. Logcat-based expectations already
 * fail closed on a relevant drop; this keeps a passed run from hiding it.
 */
export function logcatEvidenceWarning(
  report: Pick<TapHoundReport, "logcatEvidence">
): string | undefined {
  const entries = report.logcatEvidence ?? [];
  if (entries.length === 0) return undefined;
  const lines = entries.reduce((total, entry) => total + entry.droppedLines, 0);
  if (entries.every((entry) => entry.expectationImpact === "none")) {
    return `Warning (non-fatal): Logcat capture is partial (${String(lines)} line(s) dropped); `
      + "no Logcat expectation failed, and those expectations fail closed on drops in their window";
  }
  return `Warning: Logcat evidence is incomplete (${String(lines)} line(s) dropped) `
    + "and a Logcat expectation failed; the drops may be the cause";
}

function renderSummary(report: TapHoundReport): string {
  const lines = [
    `TapHound run ${report.runId}: ${report.status.toUpperCase()}`,
    `Journey: ${report.journey.name}`,
    `Package: ${report.project.packageName}`,
    ...report.environment.devices.map(
      (device) => `Device[${device.role}]: ${device.deviceSerial}`
    ),
    "",
    "Layers:",
    ...Object.entries(report.layers).map(
      ([layer, status]) => `- ${layer}: ${status}`
    )
  ];

  const logcatWarning = logcatEvidenceWarning(report);
  if (logcatWarning !== undefined) {
    lines.push("", logcatWarning);
  }
  if (report.primaryFailure !== undefined) {
    lines.push(
      "",
      `Primary failure: ${report.primaryFailure.code}: ${report.primaryFailure.message}`
    );
  }
  if (report.secondaryErrors.length > 0) {
    lines.push(
      "",
      "Secondary errors:",
      ...report.secondaryErrors.map(
        (error) => `- ${error.code}: ${error.message}`
      )
    );
  }
  return `${lines.join("\n")}\n`;
}

export class ReportWriter {
  public async writeAndPublish(
    session: ArtifactSession,
    input: TapHoundReport
  ): Promise<PublishedReport> {
    const report = TapHoundReportSchema.parse(input);
    try {
      await session.writeJson("report.json", report);
      await session.writeText("summary.txt", renderSummary(report));
      const directory = await session.publish();
      return {
        directory,
        reportPath: join(directory, "report.json"),
        summaryPath: join(directory, "summary.txt")
      };
    } catch (error) {
      await session.discard();
      throw error;
    }
  }
}
