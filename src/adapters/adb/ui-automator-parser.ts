import { z } from "zod";

import {
  LayoutElementSchema,
  type LayoutElement
} from "../../domain/layout.js";
import {
  normalizeBoundsEdges,
  normalizeResourceId
} from "../ui/layout-normalization.js";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  quot: "\"",
  apos: "'",
  lt: "<",
  gt: ">",
  amp: "&"
};

const ENTITY_PATTERN = /&(?:#(\d+)|#x([\da-fA-F]+)|(quot|apos|lt|gt|amp));/g;

function decodeCodePoint(entity: string, codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity;
}

/**
 * Single-pass XML entity decoding. Android's XML serializer escapes control
 * characters such as newlines as numeric references (`&#10;`), so multi-line
 * text must decode them to match Locators authored against the visible text.
 */
function decodeXml(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    ENTITY_PATTERN,
    (entity, decimal?: string, hex?: string, named?: string) => {
      if (decimal !== undefined) {
        return decodeCodePoint(entity, Number.parseInt(decimal, 10));
      }
      if (hex !== undefined) {
        return decodeCodePoint(entity, Number.parseInt(hex, 16));
      }
      return named === undefined ? entity : NAMED_ENTITIES[named] ?? entity;
    }
  );
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)=(["'])(.*?)\2/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    const value = match[3];
    if (key !== undefined && value !== undefined) {
      result[key] = decodeXml(value);
    }
  }
  return result;
}

function booleanAttribute(
  values: Record<string, string>,
  key: string
): boolean | undefined {
  const value = values[key];
  return value === undefined ? undefined : value === "true";
}

function bounds(value: string | undefined): LayoutElement["bounds"] {
  if (value === undefined) return undefined;
  const match = /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(value);
  if (match === null) {
    throw new Error("Invalid UIAutomator bounds");
  }
  return normalizeBoundsEdges(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4])
  );
}

/**
 * Builds one element without re-validating its subtree: `LayoutElementSchema`
 * is recursive, so parsing every node would validate each subtree once per
 * ancestor (O(nodes x depth)). The completed roots are validated exactly once
 * in `parseAccessibilityLayout`.
 */
function node(
  values: Record<string, string>,
  id: string,
  children: LayoutElement[]
): LayoutElement {
  const parsedBounds = bounds(values.bounds);
  const text = values.text;
  const contentDescription = values["content-desc"];
  const center = parsedBounds === undefined
    ? undefined
    : {
        x: Math.round((parsedBounds.left + parsedBounds.right) / 2),
        y: Math.round((parsedBounds.top + parsedBounds.bottom) / 2)
      };
  const resourceId = normalizeResourceId(values["resource-id"]);
  return {
    id,
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(text === undefined || text.length === 0 ? {} : { text }),
    ...(contentDescription === undefined || contentDescription.length === 0
      ? {}
      : { contentDescription }),
    ...(booleanAttribute(values, "clickable") === undefined
      ? {}
      : { clickable: booleanAttribute(values, "clickable") }),
    ...(booleanAttribute(values, "long-clickable") === undefined
      ? {}
      : { longClickable: booleanAttribute(values, "long-clickable") }),
    ...(booleanAttribute(values, "scrollable") === undefined
      ? {}
      : { scrollable: booleanAttribute(values, "scrollable") }),
    ...(booleanAttribute(values, "focusable") === undefined
      ? {}
      : { focusable: booleanAttribute(values, "focusable") }),
    ...(booleanAttribute(values, "focused") === undefined
      ? {}
      : { focused: booleanAttribute(values, "focused") }),
    enabled: booleanAttribute(values, "enabled") ?? true,
    ...(center === undefined ? {} : { center }),
    ...(parsedBounds === undefined ? {} : { bounds: parsedBounds }),
    children
  };
}

function parseAccessibilityLayout(
  xml: string,
  accepts: (tag: string) => boolean
): readonly LayoutElement[] {
  const roots: LayoutElement[] = [];
  const stack: Array<{
    tag: string;
    values: Record<string, string>;
    children: LayoutElement[];
    id: string;
  }> = [];
  // Quoted attribute values may legally contain an unescaped `>`.
  const tokenPattern = /<\/?([A-Za-z_][\w:.$-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g;
  let token: RegExpExecArray | null;
  let index = 0;
  while ((token = tokenPattern.exec(xml)) !== null) {
    const source = token[0];
    const tag = token[1];
    if (tag === undefined || !accepts(tag)) continue;
    if (source.startsWith("</")) {
      const current = stack.pop();
      if (current === undefined || current.tag !== tag) {
        throw new Error("Invalid UIAutomator node nesting");
      }
      const parsed = node(current.values, current.id, current.children);
      const parent = stack.at(-1);
      if (parent === undefined) roots.push(parsed);
      else parent.children.push(parsed);
      continue;
    }
    const selfClosing = source.endsWith("/>");
    const current = {
      tag,
      values: attributes(source),
      children: [] as LayoutElement[],
      id: `ui-${String(index)}`
    };
    index += 1;
    if (selfClosing) {
      const parsed = node(current.values, current.id, current.children);
      const parent = stack.at(-1);
      if (parent === undefined) roots.push(parsed);
      else parent.children.push(parsed);
    } else {
      stack.push(current);
    }
  }
  if (stack.length > 0) {
    throw new Error("Invalid UIAutomator node nesting");
  }
  return z.array(LayoutElementSchema).parse(roots);
}

export function parseUiAutomatorLayout(
  xml: string
): readonly LayoutElement[] {
  return parseAccessibilityLayout(xml, (tag) => tag === "node");
}

export function parseAppiumPageSource(
  xml: string
): readonly LayoutElement[] {
  return parseAccessibilityLayout(xml, (tag) => tag !== "hierarchy");
}
