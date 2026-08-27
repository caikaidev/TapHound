// Shared error classification helpers.
//
// Node filesystem operations throw errors whose `code` property identifies the
// errno (ENOENT, EEXIST, ELOOP, ...). Two complementary helpers cover the two
// common consumption patterns:
//
//   - errnoCode: returns the string code or undefined (replaces the repeated
//     `errorCode` helper that was duplicated across filesystem adapters).
//   - isErrnoException: type guard that narrows to NodeJS.ErrnoException so
//     callers can access `.code` after the guard (replaces the repeated
//     `isNodeError` helper that was duplicated across filesystem adapters).

export function errnoCode(error: unknown): string | undefined {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  )
    ? error.code
    : undefined;
}

export function isErrnoException(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
