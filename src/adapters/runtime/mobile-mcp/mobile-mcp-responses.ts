import type { LayoutElement } from "../../../domain/layout.js";
import type { Point } from "../../../domain/geometry.js";
import { normalizeBounds, normalizeResourceId } from "../../ui/layout-normalization.js";
import { MobileMcpToolError } from "./mobile-mcp-errors.js";
import type {
  MobileMcpDeviceEntry,
  MobileMcpElement,
  MobileMcpSwipeDirection
} from "./mobile-mcp-tools.js";

const DEVICES_TOOL = "mobile_list_available_devices";
const SCREEN_SIZE_TOOL = "mobile_get_screen_size";
const ELEMENTS_TOOL = "mobile_list_elements_on_screen";

const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function assertMobileMcpToolText(
  toolName: string,
  text: string,
  expected: string
): void {
  if (text !== expected) {
    throw new MobileMcpToolError(
      toolName,
      `unexpected response from ${toolName}: expected "${expected}", received "${text}"`
    );
  }
}

export function parseMobileMcpDevices(
  text: string
): readonly MobileMcpDeviceEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MobileMcpToolError(
      DEVICES_TOOL,
      `${DEVICES_TOOL} returned malformed JSON`,
      { cause: error }
    );
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || !Array.isArray((parsed as { devices?: unknown }).devices)
  ) {
    throw new MobileMcpToolError(
      DEVICES_TOOL,
      `${DEVICES_TOOL} response is missing the devices array`
    );
  }
  const devices = (parsed as { devices: unknown[] }).devices;
  return devices.map((entry): MobileMcpDeviceEntry => {
    if (
      entry === null
      || typeof entry !== "object"
      || typeof (entry as { id?: unknown }).id !== "string"
      || typeof (entry as { platform?: unknown }).platform !== "string"
    ) {
      throw new MobileMcpToolError(
        DEVICES_TOOL,
        `${DEVICES_TOOL} returned an invalid device entry`
      );
    }
    const record = entry as {
      id: string;
      platform: string;
      name?: unknown;
      type?: unknown;
      version?: unknown;
      state?: unknown;
      model?: unknown;
    };
    return {
      id: record.id,
      platform: record.platform,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      ...(typeof record.state === "string" ? { state: record.state } : {}),
      ...(typeof record.model === "string" ? { model: record.model } : {})
    };
  });
}

export function parseMobileMcpScreenSize(text: string): {
  width: number;
  height: number;
} {
  const match = /^Screen size is (\d+)x(\d+) pixels$/.exec(text);
  if (match === null) {
    throw new MobileMcpToolError(
      SCREEN_SIZE_TOOL,
      `${SCREEN_SIZE_TOOL} returned an unrecognized response: "${text}"`
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new MobileMcpToolError(
      SCREEN_SIZE_TOOL,
      `${SCREEN_SIZE_TOOL} returned a non-positive screen size`
    );
  }
  return { width, height };
}

export function parseMobileMcpElements(
  text: string
): readonly MobileMcpElement[] {
  const prefix = "Found these elements on screen: ";
  if (!text.startsWith(prefix)) {
    throw new MobileMcpToolError(
      ELEMENTS_TOOL,
      `${ELEMENTS_TOOL} returned an unrecognized response: "${text}"`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(prefix.length));
  } catch (error) {
    throw new MobileMcpToolError(
      ELEMENTS_TOOL,
      `${ELEMENTS_TOOL} returned a malformed element payload`,
      { cause: error }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MobileMcpToolError(
      ELEMENTS_TOOL,
      `${ELEMENTS_TOOL} returned a non-array element payload`
    );
  }
  return parsed.map((entry): MobileMcpElement => {
    if (
      entry === null
      || typeof entry !== "object"
      || !isElementRect((entry as { coordinates?: unknown }).coordinates)
    ) {
      throw new MobileMcpToolError(
        ELEMENTS_TOOL,
        `${ELEMENTS_TOOL} returned an invalid element entry`
      );
    }
    const record = entry as {
      coordinates: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      type?: unknown;
      text?: unknown;
      label?: unknown;
      name?: unknown;
      value?: unknown;
      identifier?: unknown;
      focused?: unknown;
    };
    return {
      coordinates: record.coordinates,
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.value === "string" ? { value: record.value } : {}),
      ...(typeof record.identifier === "string"
        ? { identifier: record.identifier }
        : {}),
      ...(record.focused === true ? { focused: true } : {})
    };
  });
}

function isElementRect(value: unknown): value is MobileMcpElement["coordinates"] {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.x)
    && Number.isInteger(record.y)
    && Number.isInteger(record.width)
    && Number.isInteger(record.height)
    && (record.x as number) >= 0
    && (record.y as number) >= 0
    && (record.width as number) >= 0
    && (record.height as number) >= 0
  );
}

export function parseMobileMcpAppPackages(text: string): readonly string[] {
  const packages: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\(([^()]+)\)/g)) {
    const candidate = match[1] ?? "";
    if (!ANDROID_PACKAGE_PATTERN.test(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    packages.push(candidate);
  }
  return packages;
}

export function mapMobileMcpElement(
  element: MobileMcpElement,
  index: number
): LayoutElement {
  const { coordinates } = element;
  const bounds = normalizeBounds({
    left: coordinates.x,
    top: coordinates.y,
    right: coordinates.x + coordinates.width,
    bottom: coordinates.y + coordinates.height
  });
  const center = bounds === undefined
    ? undefined
    : {
      x: Math.floor((bounds.left + bounds.right) / 2),
      y: Math.floor((bounds.top + bounds.bottom) / 2)
    };
  const resourceId = element.identifier === undefined
    ? undefined
    : normalizeResourceId(element.identifier);
  return {
    id: `mobile-mcp-${String(index)}`,
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(element.text === undefined || element.text === ""
      ? {}
      : { text: element.text }),
    ...(element.label === undefined || element.label === ""
      ? {}
      : { contentDescription: element.label }),
    ...(element.focused === true ? { focused: true } : {}),
    enabled: true,
    ...(bounds === undefined || center === undefined
      ? {}
      : { bounds, center }),
    children: []
  };
}

export interface MobileMcpSwipeMapping {
  direction: MobileMcpSwipeDirection;
  x: number;
  y: number;
  distance: number;
}

export function mapMobileMcpSwipe(
  from: Point,
  to: Point
): MobileMcpSwipeMapping {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    throw new MobileMcpToolError(
      "mobile_swipe_on_screen",
      "swipe requires movement: from and to coordinates are identical"
    );
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      direction: dx > 0 ? "right" : "left",
      x: from.x,
      y: from.y,
      distance: Math.abs(dx)
    };
  }
  return {
    direction: dy > 0 ? "down" : "up",
    x: from.x,
    y: from.y,
    distance: Math.abs(dy)
  };
}

export function mobileMcpSwipeResponse(
  mapping: MobileMcpSwipeMapping
): string {
  return [
    `Swiped ${mapping.direction} ${String(mapping.distance)} pixels`,
    `from coordinates: ${String(mapping.x)}, ${String(mapping.y)}`
  ].join(" ");
}
