import { createHash } from "node:crypto";

/**
 * Produces a conservative semantic hash for source and resource evidence.
 *
 * Comments and formatting are ignored, while string contents and all other
 * tokens remain significant. This intentionally prefers false positives over
 * allowing a potentially meaningful UI change to pass unnoticed.
 */
export function semanticSha256(value: string | Uint8Array): string {
  const source = typeof value === "string"
    ? value
    : Buffer.from(value).toString("utf8");
  let normalized = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source.charAt(index);
    const next = source.charAt(index + 1);
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (
        (current === "*" && next === "/")
        || (
          current === "-"
          && next === "-"
          && source.charAt(index + 2) === ">"
        )
      ) {
        blockComment = false;
        index += current === "*" ? 1 : 2;
      }
      continue;
    }
    if (quote !== undefined) {
      normalized += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if ((current === "/" && next === "/") || current === "#") {
      lineComment = true;
      if (current === "/") {
        index += 1;
      }
      continue;
    }
    if (
      (current === "/" && next === "*")
      || (
        current === "<"
        && next === "!"
        && source.charAt(index + 2) === "-"
        && source.charAt(index + 3) === "-"
      )
    ) {
      blockComment = true;
      index += current === "/" ? 1 : 3;
      continue;
    }
    if (current === "'" || current === "\"" || current === "`") {
      quote = current;
      normalized += current;
      continue;
    }
    if (!/\s/.test(current)) {
      normalized += current;
    }
  }
  return createHash("sha256").update(normalized).digest("hex");
}
