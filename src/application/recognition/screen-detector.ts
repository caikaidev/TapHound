import type {
  AnchorDefinition,
  ScreenDefinition,
  StatePredicate
} from "../../domain/knowledge.js";
import type {
  ScreenDetectionReceipt
} from "../../domain/knowledge-receipt.js";
import {
  hashRuntimeSnapshot,
  type RuntimeSnapshot
} from "../../domain/runtime-snapshot.js";
import {
  resolveLocatorIdentity
} from "../locator/locator-resolver.js";

export type AnchorMatchResult = {
  anchorId: string;
  result: "matched" | "missing" | "ambiguous" | "unknown";
  detail?: string | undefined;
};

export type ScreenDetectionResult = ScreenDetectionReceipt["result"];

function matchesWindow(
  value: { title: string; packageName: string; type?: string | undefined },
  anchor: Extract<AnchorDefinition["identity"], { kind: "window" }>
): boolean {
  return (anchor.title === undefined || value.title === anchor.title)
    && (
      anchor.packageName === undefined
      || value.packageName === anchor.packageName
    )
    && (anchor.type === undefined || value.type === anchor.type);
}

function matchAnchor(
  snapshot: RuntimeSnapshot,
  anchor: AnchorDefinition
): AnchorMatchResult {
  switch (anchor.identity.kind) {
    case "activity":
      return {
        anchorId: anchor.id,
        result: snapshot.activity === anchor.identity.activity
          ? "matched"
          : "missing"
      };
    case "window": {
      const hierarchy = snapshot.windowHierarchy;
      const identity = anchor.identity;
      if (hierarchy === undefined || hierarchy.status === "unknown") {
        return {
          anchorId: anchor.id,
          result: "unknown",
          detail: "Runtime window hierarchy is unavailable"
        };
      }
      const matches = hierarchy.appWindows.filter(
        (window) => matchesWindow(window, identity)
      );
      return {
        anchorId: anchor.id,
        result: matches.length === 0
          ? "missing"
          : matches.length === 1 ? "matched" : "ambiguous"
      };
    }
    case "element": {
      const resolution = resolveLocatorIdentity(
        snapshot.layout,
        anchor.identity.locator
      );
      if (resolution.status === "found") {
        return { anchorId: anchor.id, result: "matched" };
      }
      return {
        anchorId: anchor.id,
        result: resolution.code === "LOCATOR_AMBIGUOUS"
          ? "ambiguous"
          : resolution.code === "LOCATOR_NOT_FOUND" ? "missing" : "unknown",
        detail: resolution.message
      };
    }
  }
}

function predicateResult(
  predicate: StatePredicate,
  snapshot: RuntimeSnapshot,
  evidence: ReadonlyMap<string, AnchorMatchResult>
): "match" | "noMatch" | "unknown" {
  if (predicate.kind === "activityIs") {
    return snapshot.activity === predicate.activity ? "match" : "noMatch";
  }
  const anchor = evidence.get(predicate.anchorId);
  if (anchor === undefined || anchor.result === "unknown") return "unknown";
  if (anchor.result === "ambiguous") return "unknown";
  if (predicate.kind === "anchorAbsent") {
    return anchor.result === "missing" ? "match" : "noMatch";
  }
  return anchor.result === "matched" ? "match" : "noMatch";
}

function screenResult(
  screen: ScreenDefinition,
  snapshot: RuntimeSnapshot,
  evidence: ReadonlyMap<string, AnchorMatchResult>
): "match" | "noMatch" | "unknown" {
  let unknown = false;
  for (const anchorId of screen.requiredAnchors) {
    const result = evidence.get(anchorId)?.result;
    if (result === "missing") return "noMatch";
    if (result !== "matched") unknown = true;
  }
  for (const anchorId of screen.forbiddenAnchors) {
    const result = evidence.get(anchorId)?.result;
    if (result === "matched") return "noMatch";
    if (result !== "missing") unknown = true;
  }
  for (const predicate of screen.predicates) {
    const result = predicateResult(predicate, snapshot, evidence);
    if (result === "noMatch") return "noMatch";
    if (result === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "match";
}

export class ScreenDetector {
  public readonly detect = (input: {
    snapshot: RuntimeSnapshot;
    anchors: readonly AnchorDefinition[];
    screens: readonly ScreenDefinition[];
  }): ScreenDetectionResult => {
    const evidence = input.anchors.map(
      (anchor) => matchAnchor(input.snapshot, anchor)
    );
    const byAnchor = new Map(evidence.map((result) => [result.anchorId, result]));
    const results = input.screens.map((screen) => ({
      screen,
      result: screenResult(screen, input.snapshot, byAnchor)
    }));
    const matched = results
      .filter((result) => result.result === "match")
      .map((result) => result.screen.id)
      .sort((left, right) => left.localeCompare(right));
    const uncertain = results.some((result) => result.result === "unknown");
    if (matched.length > 1) {
      return { status: "ambiguous", screenIds: matched, evidence };
    }
    const screenId = matched[0];
    if (screenId !== undefined && !uncertain) {
      return { status: "matched", screenId, evidence };
    }
    return { status: "unknown", evidence };
  };

  public readonly receipt = (input: {
    id: string;
    recordedAt: string;
    knowledgeHash: string;
    snapshot: RuntimeSnapshot;
    anchors: readonly AnchorDefinition[];
    screens: readonly ScreenDefinition[];
  }): ScreenDetectionReceipt => ({
    version: 1,
    id: input.id,
    kind: "screenDetection",
    recordedAt: input.recordedAt,
    knowledgeHash: input.knowledgeHash,
    snapshotHash: hashRuntimeSnapshot(input.snapshot),
    result: this.detect(input)
  });
}
