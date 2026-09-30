import {
  GenerationSessionSchema,
  type GenerationSession
} from "../../domain/generation.js";
import type { TouchPolicy } from "../../domain/journey.js";
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
import {
  locatorEvidenceForElement
} from "../../domain/locator-evidence.js";
import {
  resolveActionTarget,
  type TargetedAction
} from "../interaction/action-target.js";
import { expectationHoldsOnScreen } from "../assertion/expectation-evaluator.js";
import { resolveLocator } from "../locator/locator-resolver.js";
import { hasExactlyOneEnabledFocusedElement } from "./focused-input.js";
import { GenerationOperationError } from "./generation-starter.js";

export interface ProposedStepValidationInput {
  session: GenerationSession;
  snapshot: RuntimeSnapshot;
  proposal: ProposedStep;
}

function rejectCapability(message: string): never {
  throw new GenerationOperationError("ACTION_UNSUPPORTED", message);
}

/**
 * Report the same Locator verdict Replay would: an unknown or ambiguous
 * target is a Locator failure, not an unsupported action.
 */
function rejectResolution(
  resolution: Extract<ReturnType<typeof resolveLocator>, { status: "failed" }>
): never {
  if (
    resolution.code === "LOCATOR_NOT_FOUND"
    || resolution.code === "LOCATOR_AMBIGUOUS"
  ) {
    throw new GenerationOperationError(resolution.code, resolution.message);
  }
  rejectCapability(resolution.message);
}

/**
 * Reject a proposal whose target Replay could not act on, using the action
 * capability rules both engines share.
 */
function requireActionTarget(
  snapshot: RuntimeSnapshot,
  action: TargetedAction,
  locator: Locator,
  touchPolicy?: TouchPolicy
): void {
  const resolved = resolveActionTarget(
    snapshot.layout,
    action,
    locator,
    undefined,
    touchPolicy
  );
  if (resolved.status !== "found") {
    rejectResolution(resolved);
  }
}

/**
 * `touchPolicy: "element"` is reserved for targets no ancestor claims, and
 * its expectation must still be unmet so that passing proves the touch.
 */
function requireElementTouch(
  snapshot: RuntimeSnapshot,
  proposal: Extract<ProposedStep, { action: "click" | "longClick" }>
): void {
  const capable = resolveActionTarget(
    snapshot.layout,
    proposal.action,
    proposal.locator,
    undefined
  );
  if (capable.status === "found") {
    rejectCapability(
      `${proposal.action} target already reports its capability; omit touchPolicy`
    );
  }
  if (
    capable.code === "LOCATOR_NOT_FOUND"
    || capable.code === "LOCATOR_AMBIGUOUS"
  ) {
    rejectResolution(capable);
  }
  requireActionTarget(snapshot, proposal.action, proposal.locator, "element");
  if (
    proposal.expect !== undefined
    && expectationHoldsOnScreen(
      proposal.expect,
      snapshot.layout,
      snapshot.activity
    )
  ) {
    throw new GenerationOperationError(
      "EXPECT_UNSUPPORTED",
      "touchPolicy element expectation already holds before the touch, so it cannot prove the touch took effect"
    );
  }
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
      `Proposal before Activity ${proposal.activity.before} does not match the current snapshot Activity ${snapshot.activity}`,
      {
        field: "activity.before",
        expected: snapshot.activity,
        actual: proposal.activity.before
      }
    );
  }
}

function validateAction(
  snapshot: RuntimeSnapshot,
  proposal: ProposedStep
): void {
  if (
    (proposal.action === "click" || proposal.action === "longClick")
    && proposal.touchPolicy === "element"
  ) {
    requireElementTouch(snapshot, proposal);
    return;
  }
  if (
    proposal.action === "click"
    || proposal.action === "longClick"
    || proposal.action === "swipe"
  ) {
    requireActionTarget(snapshot, proposal.action, proposal.locator);
    return;
  }
  if (proposal.action === "scrollTo") {
    requireActionTarget(snapshot, "swipe", proposal.container);
    const target = resolveLocator(
      snapshot.layout,
      proposal.locator,
      { requireEnabled: false }
    );
    if (target.status === "failed" && target.code === "LOCATOR_AMBIGUOUS") {
      throw new GenerationOperationError(
        "LOCATOR_AMBIGUOUS",
        `scrollTo target is ambiguous: ${target.message}`
      );
    }
    return;
  }
  if (proposal.action === "inputText") {
    if (!hasExactlyOneEnabledFocusedElement(snapshot.layout)) {
      rejectCapability(
        "inputText requires exactly one enabled focused visible Layout element"
      );
    }
    return;
  }
  if (proposal.action === "bridge") {
    requireActionTarget(snapshot, "click", proposal.triggerLocator);
    return;
  }
}

function bindLocatorEvidence(
  layout: readonly LayoutElement[],
  locator: Locator
): Locator {
  if (locator.index === undefined) {
    return locator;
  }
  const resolution = resolveLocator(layout, locator, {
    requireEnabled: false
  });
  // Evidence binds the identity-matched entry before capability promotion.
  return resolution.status === "found"
    ? {
        ...locator,
        evidence: locatorEvidenceForElement(resolution.element)
      }
    : locator;
}

function bindProposalEvidence(
  snapshot: RuntimeSnapshot,
  proposal: ProposedStep
): ProposedStep {
  const expect = proposal.expect?.type === "element"
    ? {
        ...proposal.expect,
        locator: bindLocatorEvidence(
          snapshot.layout,
          proposal.expect.locator
        )
      }
    : proposal.expect;
  const common = expect === undefined ? {} : { expect };
  switch (proposal.action) {
    case "click":
    case "longClick":
    case "swipe":
      return ProposedStepSchema.parse({
        ...proposal,
        ...common,
        locator: bindLocatorEvidence(snapshot.layout, proposal.locator)
      });
    case "scrollTo":
      return ProposedStepSchema.parse({
        ...proposal,
        ...common,
        locator: bindLocatorEvidence(snapshot.layout, proposal.locator),
        container: bindLocatorEvidence(snapshot.layout, proposal.container)
      });
    case "inputText":
    case "back":
    case "wait":
      return ProposedStepSchema.parse({ ...proposal, ...common });
    case "bridge":
      return ProposedStepSchema.parse({
        ...proposal,
        ...common,
        triggerLocator: bindLocatorEvidence(
          snapshot.layout,
          proposal.triggerLocator
        )
      });
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
    return bindProposalEvidence(snapshot, proposal);
  }
}
