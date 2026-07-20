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

function renderSummary(report: TapHoundReport): string {
  const lines = [
    `TapHound run ${report.runId}: ${report.status.toUpperCase()}`,
    `Journey: ${report.journey.name}`,
    `Package: ${report.project.packageName}`,
    `Device: ${report.environment.deviceSerial}`,
    "",
    "Layers:",
    ...Object.entries(report.layers).map(
      ([layer, status]) => `- ${layer}: ${status}`
    )
  ];

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
