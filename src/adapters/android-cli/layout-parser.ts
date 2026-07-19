import {
  BoundsSchema,
  LayoutPointSchema,
  type LayoutElement,
  type LayoutPoint
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
  if (value === undefined) {
    return undefined;
  }
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

function parseCenter(value: unknown): LayoutPoint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const match = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
    if (match === null) {
      throw new Error("Invalid Android Layout center");
    }
    return LayoutPointSchema.parse({
      x: Number(match[1]),
      y: Number(match[2])
    });
  }
  return LayoutPointSchema.parse(value);
}

function stringSet(record: Record<string, unknown>, key: string): Set<string> {
  const value = record[key];
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid Android Layout ${key}`);
  }
  return new Set(value);
}

function elementId(record: Record<string, unknown>, path: string): string {
  const value = record.id ?? record.key;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : path;
}

function parseElement(value: unknown, path: string): LayoutElement | undefined {
  const record = asRecord(value);
  if (optionalBoolean(record, "off-screen") === true) {
    return undefined;
  }
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
  const interactions = stringSet(record, "interactions");
  const clickable = optionalBoolean(record, "clickable")
    ?? (interactions.has("clickable") ? true : undefined);
  const longClickable = optionalBoolean(record, "longClickable")
    ?? optionalBoolean(record, "long-clickable")
    ?? (interactions.has("long-clickable") ? true : undefined);
  const scrollable = optionalBoolean(record, "scrollable")
    ?? (interactions.has("scrollable") ? true : undefined);
  const bounds = parseBounds(record.bounds);
  const parsedCenter = parseCenter(record.center);
  const center = parsedCenter ?? (bounds === undefined
    ? undefined
    : {
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2)
      });
  if (center === undefined) {
    throw new Error("Android Layout element has no visible center or bounds");
  }

  const children = childrenValue.flatMap((child, index) => {
    const parsed = parseElement(child, `${path}/${String(index)}`);
    return parsed === undefined ? [] : [parsed];
  });

  return {
    id: elementId(record, path),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(text === undefined ? {} : { text }),
    ...(contentDescription === undefined ? {} : { contentDescription }),
    ...(clickable === undefined ? {} : { clickable }),
    ...(longClickable === undefined ? {} : { longClickable }),
    ...(scrollable === undefined ? {} : { scrollable }),
    enabled: optionalBoolean(record, "enabled") ?? true,
    center,
    ...(bounds === undefined ? {} : { bounds }),
    children
  };
}

export function parseLayout(stdout: string): readonly LayoutElement[] {
  const parsed = parseJson(stdout, "Layout");
  try {
    if (Array.isArray(parsed)) {
      return parsed.flatMap((element, index) => {
        const normalized = parseElement(element, String(index));
        return normalized === undefined ? [] : [normalized];
      });
    }
    const normalized = parseElement(parsed, "0");
    return normalized === undefined ? [] : [normalized];
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
