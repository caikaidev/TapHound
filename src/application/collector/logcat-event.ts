import type { EventCapture, LogcatEventExpect } from "../../domain/logcat-event.js";
import type { LogcatLine } from "./logcat-collector.js";

/** Events are JSON objects in the message, with an `event` and `fields` object. */
export function matchesLogcatEvent(
  line: LogcatLine,
  expect: LogcatEventExpect
): boolean {
  if (line.pid === undefined || line.tag !== expect.tag
    || line.message === undefined) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(line.message) as unknown;
  } catch {
    return false;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.event !== expect.event) {
    return false;
  }
  const fields = record.fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return false;
  }
  const facts = fields as Record<string, unknown>;
  return Object.entries(expect.fields).every(([key, item]) => facts[key] === item)
    && (expect.correlation === undefined
      || facts[expect.correlation.key] === expect.correlation.value);
}

/** Read only a declared field from the uniquely matched structured event. */
export function captureLogcatEvent(
  line: LogcatLine,
  expect: LogcatEventExpect,
  capture: EventCapture
): string | undefined {
  if (!matchesLogcatEvent(line, expect) || line.message === undefined) return undefined;
  const event = JSON.parse(line.message) as { fields: Record<string, unknown> };
  const key = capture.field ?? expect.correlation?.key;
  if (key === undefined) return undefined;
  const value = event.fields[key];
  if (capture.valueType === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value)
      ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  if (capture.valueType === "identifier") {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
  }
  if (value.length === 0 || value.length > 128) return undefined;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 32 || point === 127) return undefined;
  }
  return value;
}

/** Only a stable, structured app-emitted class is accepted. */
export function requestErrorClassFor(
  line: LogcatLine
): "client" | "auth" | "network" | "server" | undefined {
  if (line.message === undefined) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line.message) as unknown;
  } catch {
    return undefined;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const fields = (event as Record<string, unknown>).fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return undefined;
  }
  const value = (fields as Record<string, unknown>).errorClass;
  return value === "client" || value === "auth"
    || value === "network" || value === "server"
    ? value : undefined;
}
