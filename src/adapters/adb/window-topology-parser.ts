import {
  WindowTopologySchema,
  type AppWindow,
  type WindowTopology
} from "../../domain/window-hierarchy.js";

const WINDOW_HEADER = /^\s*Window #\d+ Window\{(\S+)\s+u\d+\s+(.+)}:$/;
const FRAME = /\bframe=\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/;

function windowBlocks(stdout: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (WINDOW_HEADER.test(line)) {
      current = [line];
      blocks.push(current);
    } else {
      current?.push(line);
    }
  }
  return blocks;
}

function value(
  lines: readonly string[],
  pattern: RegExp
): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function parseBounds(lines: readonly string[]): AppWindow["bounds"] {
  const frames = lines.find((line) => line.includes("Frames:"));
  const match = frames === undefined ? null : FRAME.exec(frames);
  if (
    match?.[1] === undefined
    || match[2] === undefined
    || match[3] === undefined
    || match[4] === undefined
  ) {
    return undefined;
  }
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (
    left === undefined
    || top === undefined
    || right === undefined
    || bottom === undefined
    || left < 0
    || top < 0
    || right <= left
    || bottom <= top
  ) {
    return undefined;
  }
  return { left, top, right, bottom };
}

function parseWindow(
  lines: readonly string[],
  packageName: string,
  focusedWindowId: string | undefined
): AppWindow | undefined {
  const header = lines[0];
  const headerMatch = header === undefined ? null : WINDOW_HEADER.exec(header);
  if (
    headerMatch?.[1] === undefined
    || headerMatch[2] === undefined
    || value(lines, /\bpackage=(\S+)/) !== packageName
    || !lines.some((line) => /\bisVisible=true\b/.test(line))
    || !lines.some((line) => /\bisOnScreen=true\b/.test(line))
    || !lines.some((line) => /\bmHasSurface=true\b/.test(line))
    || !lines.some((line) => /\bisReadyForDisplay\(\)=true\b/.test(line))
  ) {
    return undefined;
  }
  const attrs = lines.findIndex((line) => line.includes("mAttrs={"));
  const attrsEnd = attrs < 0
    ? attrs
    : lines.findIndex((line, index) => (
        index >= attrs && line.trim().endsWith("}")
      ));
  const attributeLines = attrs < 0
    ? []
    : lines.slice(attrs, attrsEnd < attrs ? attrs + 1 : attrsEnd + 1);
  const bounds = parseBounds(lines);
  const layer = value(lines, /\bmBaseLayer=(\d+)/);
  const type = value(attributeLines, /\bty=([A-Z0-9_]+)/);
  return {
    id: headerMatch[1],
    title: headerMatch[2],
    packageName,
    ...(type === undefined ? {} : { type }),
    ...(layer === undefined ? {} : { layer: Number(layer) }),
    ...(bounds === undefined ? {} : { bounds }),
    touchable: !attributeLines.some((line) => /\bNOT_TOUCHABLE\b/.test(line)),
    ...(attributeLines.some((line) => /\bfl=/.test(line))
      ? {
          focusable: !attributeLines.some(
            (line) => /\bNOT_FOCUSABLE\b/.test(line)
          )
        }
      : {}),
    ...(focusedWindowId === undefined
      ? {}
      : { focused: focusedWindowId === headerMatch[1] })
  };
}

export function parseWindowTopology(
  stdout: string,
  packageName: string
): WindowTopology {
  const focusedWindowId = value(
    stdout.split(/\r?\n/),
    /\bmCurrentFocus=Window\{(\S+)/
  );
  return WindowTopologySchema.parse({
    version: 1,
    status: "observed",
    windows: windowBlocks(stdout)
      .flatMap((block) => {
        const window = parseWindow(block, packageName, focusedWindowId);
        return window === undefined || !window.touchable ? [] : [window];
      })
      .sort((left, right) => (
        (right.layer ?? 0) - (left.layer ?? 0)
        || left.id.localeCompare(right.id)
      ))
  });
}
