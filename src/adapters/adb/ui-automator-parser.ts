import {
  BoundsSchema,
  LayoutElementSchema,
  type LayoutElement
} from "../../domain/layout.js";

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
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
  return BoundsSchema.parse({
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  });
}

function resourceId(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const separator = value.lastIndexOf(":id/");
  return separator >= 0 ? value.slice(separator + 4) : value;
}

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
  return LayoutElementSchema.parse({
    id,
    ...(resourceId(values["resource-id"]) === undefined
      ? {}
      : { resourceId: resourceId(values["resource-id"]) }),
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
  });
}

export function parseUiAutomatorLayout(
  xml: string
): readonly LayoutElement[] {
  const roots: LayoutElement[] = [];
  const stack: Array<{
    values: Record<string, string>;
    children: LayoutElement[];
    id: string;
  }> = [];
  const tokenPattern = /<node\b[^>]*\/>|<node\b[^>]*>|<\/node>/g;
  let token: RegExpExecArray | null;
  let index = 0;
  while ((token = tokenPattern.exec(xml)) !== null) {
    const source = token[0];
    if (source === "</node>") {
      const current = stack.pop();
      if (current === undefined) {
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
  return roots;
}
