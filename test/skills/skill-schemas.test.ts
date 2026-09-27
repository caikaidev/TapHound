import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ProposedStepSchema } from "../../src/domain/proposed-step.js";
import { WorkflowManifestSchema } from "../../src/domain/workflow-manifest.js";

type JsonSchema = Record<string, unknown>;

/** Property names per `action` const found anywhere in a JSON Schema. */
function actionProperties(root: JsonSchema): Map<string, string[]> {
  const definitions = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>;
  const found = new Map<string, string[]>();
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const schema = node as JsonSchema;
    if (typeof schema.$ref === "string") {
      visit(definitions[schema.$ref.split("/").at(-1) ?? ""]);
      return;
    }
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    const action = properties?.action?.const;
    if (typeof action === "string" && properties !== undefined) {
      found.set(action, Object.keys(properties).sort());
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(root);
  return found;
}

describe("Skill JSON Schemas", () => {
  it("keep every step proposal action in sync with the Core schema", async () => {
    const skill = JSON.parse(await readFile(
      "assets/skills/taphound-journey-generator/schemas/proposed-step-envelope.json",
      "utf8"
    )) as JsonSchema;
    const core = actionProperties(z.toJSONSchema(ProposedStepSchema, {
      io: "input",
      unrepresentable: "any"
    }));
    // Bridge proposals are built by `generation bridge`, never submitted in
    // the step envelope.
    core.delete("bridge");

    expect(Object.fromEntries(actionProperties(skill)))
      .toEqual(Object.fromEntries(core));
  });

  it("ship the Workflow manifest schema rendered from the Core schema", async () => {
    const shipped = await readFile(
      "assets/skills/taphound-verify-change/schemas/workflow-manifest.schema.json",
      "utf8"
    );

    // Stale? Run `npm run build && npm run skills:schemas`.
    expect(shipped).toBe(
      `${JSON.stringify(z.toJSONSchema(WorkflowManifestSchema), null, 2)}\n`
    );
  });
});
