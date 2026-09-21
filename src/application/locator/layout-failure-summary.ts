import type { LayoutElement } from "../../domain/layout.js";

const MAX_NOTABLE = 8;
const MAX_LABEL_TEXT = 24;

/**
 * Bounded, human-scannable description of the screen at the moment a
 * Locator or Expectation failed, so an operator (or agent) can tell an
 * environment blocker (lock screen, permission dialog, empty window)
 * from a genuine regression without re-dumping the UI hierarchy.
 */

function truncate(value: string): string {
  return value.length <= MAX_LABEL_TEXT
    ? value
    : `${value.slice(0, MAX_LABEL_TEXT - 1)}…`;
}

function label(element: LayoutElement): string | undefined {
  const id = element.resourceId;
  const text = element.text === undefined || element.text === ""
    ? undefined
    : truncate(element.text);
  const description = element.contentDescription === undefined
    || element.contentDescription === ""
    ? undefined
    : truncate(element.contentDescription);
  if (id !== undefined && text !== undefined) {
    return `#${id} "${text}"`;
  }
  if (id !== undefined) {
    return `#${id}`;
  }
  if (text !== undefined) {
    return `"${text}"`;
  }
  if (description !== undefined) {
    return `(${description})`;
  }
  return undefined;
}

function salience(element: LayoutElement): number {
  return (element.clickable === true || element.scrollable === true ? 2 : 0)
    + (element.focused === true || element.focusable === true ? 1 : 0);
}

export function summarizeLayoutElements(
  elements: readonly LayoutElement[]
): string {
  if (elements.length === 0) {
    return "Screen shows no Layout elements";
  }
  const notable: string[] = [];
  const seen = new Set<string>();
  const ranked = elements
    .filter((element) => label(element) !== undefined)
    .sort((a, b) => salience(b) - salience(a));
  for (const element of ranked) {
    const text = label(element);
    if (text === undefined || seen.has(text)) {
      continue;
    }
    seen.add(text);
    notable.push(text);
    if (notable.length >= MAX_NOTABLE) {
      break;
    }
  }
  if (notable.length === 0) {
    return `Screen shows ${String(elements.length)} element(s),`
      + " none with resourceId, text, or contentDescription";
  }
  return `Screen shows ${String(elements.length)} element(s);`
    + ` notable: ${notable.join(", ")}`;
}
