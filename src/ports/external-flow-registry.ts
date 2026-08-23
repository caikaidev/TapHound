import type { ExternalFlow } from "../domain/external-flow.js";

export interface ExternalFlowRecord {
  bytes: Buffer;
  flow: ExternalFlow;
  source: "builtin" | "project";
  path: string;
}

export interface ExternalFlowCatalogEntry {
  name: string;
  source: "builtin" | "project";
  path: string;
  status: "valid" | "invalid";
  escapedPackageName?: string | undefined;
  stepCount?: number | undefined;
  failure?: { code: string; message: string } | undefined;
}

export interface ExternalFlowRegistry {
  read: (input: {
    projectRoot: string;
    name: string;
  }) => Promise<ExternalFlowRecord>;
  list: (projectRoot: string) => Promise<readonly ExternalFlowCatalogEntry[]>;
}
