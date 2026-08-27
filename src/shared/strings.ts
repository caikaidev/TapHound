// Deterministic string comparison utilities shared across layers.
//
// localeCompare is locale/ICU dependent and can produce different orderings
// across platforms or Node ICU builds. Any data that feeds a hash (inventory
// path sets, evidence manifests, canonicalized evidence keys) must be sorted
// with a stable, environment-independent comparator. Use compareStrings for
// hashed or persisted orderings; reserve localeCompare for display-only sorts.

export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function sortStrings(values: string[]): string[] {
  return [...values].sort(compareStrings);
}
