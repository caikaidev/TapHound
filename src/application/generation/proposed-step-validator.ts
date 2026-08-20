import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import type { LayoutElement, Locator } from "../../domain/layout.js";
import {
  ProposedStepSchema,
  type ProposedStep
} from "../../domain/proposed-step.js";
import {
  RuntimeSnapshotSchema,
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../domain/runtime-snapshot.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface ProposedStepValidationInput {
  session: GenerationSession;
  snapshot: RuntimeSnapshot;
  proposal: ProposedStep;
}

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
}

function rejectCapability(message: string): never {
  throw new GenerationOperationError("ACTION_UNSUPPORTED", message);
}

function requireUniqueTarget(
  snapshot: RuntimeSnapshot,
  locator: Locator,
  capability: (element: LayoutElement) => boolean,
  capabilityName: string
): LayoutElement {
  const resolution = resolveLocator(snapshot.layout, locator);
  const capabilityKey = capabilityName === "clickable"
    ? "clickable"
    : capabilityName === "longClickable"
      ? "longClickable"
      : undefined;
  const resolved = capabilityKey === undefined
    ? resolution
    : resolveLocator(snapshot.layout, locator, {
        requiredCapability: capabilityKey
      });
  if (resolved.status !== "found") {
    rejectCapability(resolved.message);
  }
  if (!capability(resolved.element)) {
    rejectCapability(
      `Layout target lacks required ${capabilityName} capability`
    );
  }
  return resolved.element;
}

function validateBinding(
  session: GenerationSession,
  snapshot: RuntimeSnapshot,
  proposal: ProposedStep
): void {
  const binding = proposal.binding;
  if (
    session.state !== "active"
    || session.inFlight !== null
    || session.pendingConfirmation !== null
    || session.verification.status !== "notRun"
    || session.publication.status !== "notRun"
    || binding.generationId !== session.id
    || binding.baseRevision !== session.revision
    || binding.snapshotHash !== session.bindings.snapshotHash
    || snapshot.generationId !== session.id
    || snapshot.baseRevision !== session.revision
    || snapshot.deviceSerial !== session.target.deviceSerial
    || hashRuntimeSnapshot(snapshot) !== binding.snapshotHash
  ) {
    throw new GenerationOperationError(
      "SNAPSHOT_STALE",
      "Proposal is not bound to the authoritative generation snapshot"
    );
  }
  if (
    snapshot.expectedPackageName !== session.target.packageName
    || snapshot.foregroundPackageName !== session.target.packageName
  ) {
    throw new GenerationOperationError(
      "PACKAGE_ESCAPE",
      "Foreground package escaped the generation target"
    );
  }
  if (snapshot.activity !== proposal.activity.before) {
    throw new GenerationOperationError(
      "SNAPSHOT_STALE",
      "Proposal before Activity does not match the current snapshot"
    );
  }
}

function validateAction(
  snapshot: RuntimeSnapshot,
  proposal: ProposedStep
): void {
  if (proposal.action === "click") {
    requireUniqueTarget(
      snapshot,
      proposal.locator,
      (element) => element.clickable === true,
      "clickable"
    );
    return;
  }
  if (proposal.action === "longClick") {
    requireUniqueTarget(
      snapshot,
      proposal.locator,
      (element) => element.longClickable === true,
      "longClickable"
    );
    return;
  }
  if (proposal.action === "swipe") {
    requireUniqueTarget(
      snapshot,
      proposal.locator,
      (element) => element.scrollable === true
        && element.bounds !== undefined,
      "scrollable bounds"
    );
    return;
  }
  if (proposal.action === "scrollTo") {
    requireUniqueTarget(
      snapshot,
      proposal.container,
      (element) => element.scrollable === true
        && element.bounds !== undefined,
      "scrollable container bounds"
    );
    const target = resolveLocator(
      snapshot.layout,
      proposal.locator,
      { requireEnabled: false }
    );
    if (target.status === "failed" && target.code === "LOCATOR_AMBIGUOUS") {
      rejectCapability(`scrollTo target is ambiguous: ${target.message}`);
    }
    return;
  }
  if (proposal.action === "inputText") {
    const focused = flatten(snapshot.layout).filter(
      (element) => element.enabled && element.focused === true
    );
    if (focused.length !== 1) {
      rejectCapability(
        "inputText requires exactly one enabled focused visible Layout element"
      );
    }
  }
}

function validateWindowHierarchy(snapshot: RuntimeSnapshot): void {
  if (snapshot.windowHierarchy?.status === "incomplete") {
    throw new GenerationOperationError(
      "WINDOW_HIERARCHY_INCOMPLETE",
      snapshot.windowHierarchy.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; "),
      {
        diagnostics: snapshot.windowHierarchy.diagnostics,
        recovery: snapshot.windowHierarchy.recovery
      }
    );
  }
}

export class ProposedStepValidator {
  public validate(input: ProposedStepValidationInput): ProposedStep {
    const session = GenerationSessionSchema.parse(input.session);
    const snapshot = RuntimeSnapshotSchema.parse(input.snapshot);
    const proposal = ProposedStepSchema.parse(input.proposal);
    validateBinding(session, snapshot, proposal);
    validateWindowHierarchy(snapshot);
    validateAction(snapshot, proposal);
    return proposal;
  }
}
