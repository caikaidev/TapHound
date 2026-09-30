import type { UiBackendDescriptor } from "../../domain/ui-backend.js";

const SAME_CONFIG_HINT = "rerun with the same --config (and ui.backend) used at generation start";

function short(hash: string): string {
  return hash.slice(0, 12);
}

/** Names the bound and current configuration hashes, never file paths. */
export function configMismatchMessage(bound: string, current: string): string {
  return "Generation configuration does not match the authoritative session"
    + ` (session config sha256 ${short(bound)}…, current ${short(current)}…);`
    + ` ${SAME_CONFIG_HINT}`;
}

export function uiBackendMismatchMessage(
  bound: UiBackendDescriptor,
  current: UiBackendDescriptor
): string {
  const describe = (descriptor: UiBackendDescriptor): string => (
    `${descriptor.id} ${descriptor.adapterVersion} config ${short(descriptor.configSha256)}…`
  );
  return "Generation UI backend does not match the authoritative session"
    + ` (session ${describe(bound)}, current ${describe(current)});`
    + ` ${SAME_CONFIG_HINT}`;
}
