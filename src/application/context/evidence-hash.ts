import { createHash } from "node:crypto";

// Produces a conservative semantic hash for source and resource evidence.
//
// Comments and formatting whitespace are ignored, while string contents and
// all other tokens remain significant. This intentionally prefers false
// positives over allowing a potentially meaningful UI change to pass
// unnoticed.
//
// Supported comment forms: double-slash and hash line comments, C-style and
// XML block comments. Hash is retained because Gradle .properties provenance
// files use it.
//
// String literals (single quote, double quote, backtick) preserve their
// contents verbatim, with backslash escapes honored so a quote inside a
// string does not close it.
//
// Kotlin raw strings (triple double-quote) and XML CDATA sections are
// treated as opaque literals: their full content is preserved (including
// internal whitespace, which is semantically significant in both) and no
// comment or quote sequence inside them is interpreted.
export function semanticSha256(value: string | Uint8Array): string {
  const source = typeof value === "string"
    ? value
    : Buffer.from(value).toString("utf8");
  let normalized = "";
  let quote: "'" | "\"" | "`" | undefined;
  let rawString = false;
  let cdata = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source.charAt(index);
    const next = source.charAt(index + 1);
    const after = source.charAt(index + 2);

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
          && after === ">"
        )
      ) {
        blockComment = false;
        index += current === "*" ? 1 : 2;
      }
      continue;
    }
    if (cdata) {
      if (current === "]" && next === "]" && after === ">") {
        cdata = false;
        index += 2;
        continue;
      }
      normalized += current;
      continue;
    }
    if (rawString) {
      if (current === "\"" && next === "\"" && after === "\"") {
        rawString = false;
        normalized += "\"\"\"";
        index += 2;
        continue;
      }
      normalized += current;
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
    if (current === "\"" && next === "\"" && after === "\"") {
      rawString = true;
      normalized += "\"\"\"";
      index += 2;
      continue;
    }
    if (
      current === "<"
      && next === "!"
      && after === "["
      && source.startsWith("[CDATA[", index + 2)
    ) {
      cdata = true;
      normalized += source.slice(index, index + 9);
      index += 8;
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
        && after === "-"
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
