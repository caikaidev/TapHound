import {
  BoundsSchema,
  type LayoutElement
} from "../../domain/layout.js";

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid Android ${label} JSON`, { cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Android Layout element");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function parseBounds(value: unknown): LayoutElement["bounds"] {
  if (typeof value === "string") {
    const match = /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(value);
    if (match === null) {
      throw new Error("Invalid Android Layout bounds");
    }
    return BoundsSchema.parse({
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[3]),
      bottom: Number(match[4])
    });
  }
  return BoundsSchema.parse(value);
}

function parseElement(value: unknown, path: string): LayoutElement {
  const record = asRecord(value);
  const childrenValue = record.children ?? [];
  if (!Array.isArray(childrenValue)) {
    throw new Error("Invalid Android Layout children");
  }

  const resourceId = optionalString(record, "resourceId", "resource-id");
  const text = optionalString(record, "text");
  const contentDescription = optionalString(
    record,
    "contentDescription",
    "content-desc"
  );
  const clickable = optionalBoolean(record, "clickable");

  return {
    id: optionalString(record, "id") ?? path,
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(text === undefined ? {} : { text }),
    ...(contentDescription === undefined ? {} : { contentDescription }),
    ...(clickable === undefined ? {} : { clickable }),
    enabled: optionalBoolean(record, "enabled") ?? true,
    bounds: parseBounds(record.bounds),
    children: childrenValue.map((child, index) => (
      parseElement(child, `${path}/${String(index)}`)
    ))
  };
}

export function parseLayout(stdout: string): readonly LayoutElement[] {
  const parsed = parseJson(stdout, "Layout");
  try {
    return Array.isArray(parsed)
      ? parsed.map((element, index) => parseElement(element, String(index)))
      : [parseElement(parsed, "0")];
  } catch (error) {
    throw new Error("Invalid Android Layout structure", { cause: error });
  }
}

export function parseLayoutDiff(stdout: string): readonly unknown[] {
  const parsed = parseJson(stdout, "Layout Diff");
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid Android Layout Diff structure");
  }
  return parsed;
}
