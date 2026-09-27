#!/usr/bin/env node
// Renders JSON Schemas that installed Skills ship from Core's Zod schemas.
// Run after `npm run build`; test/skills/skill-schemas.test.ts fails when a
// rendered file is stale.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const { WorkflowManifestSchema } = await import(
  resolve(root, "dist/domain/workflow-manifest.js")
);

const renderedSchemas = [{
  path: "assets/skills/taphound-verify-change/schemas/workflow-manifest.schema.json",
  schema: WorkflowManifestSchema
}];

for (const { path, schema } of renderedSchemas) {
  await writeFile(
    resolve(root, path),
    `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`
  );
}
