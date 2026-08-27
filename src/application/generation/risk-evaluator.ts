import type { ProposedStep } from "../../domain/proposed-step.js";
import type { InteractionPolicy } from "../../domain/project-context.js";
import type { RuntimeSnapshot } from "../../domain/runtime-snapshot.js";
import { resolveLocator } from "../locator/locator-resolver.js";

export type EffectiveRisk =
  | "safe"
  | "confirmationRequired"
  | "forbidden";

export interface RiskEvaluation {
  effectiveRisk: EffectiveRisk;
  semanticSideEffect?: {
    category: "hardCommit" | "destructive" | "account";
    matchedTerm: string;
  } | undefined;
}

const SEMANTIC_TERMS = {
  destructive: [
    "delete", "remove", "erase", "clear", "unsubscribe", "unfollow",
    "leave", "block", "report"
  ],
  // hardCommit: irreversible or financial actions that still require
  // confirmation even when the action is otherwise allowed.
  hardCommit: [
    "send", "pay", "purchase", "buy", "order", "transfer", "donate",
    "book", "reserve", "subscribe", "submit", "confirm"
  ],
  // softCommit: reversible content or navigation actions (e.g. Create Group
  // is navigation, Save Draft is reversible). These default to safe so that
  // common UI flows are not blocked by semantic keyword matches. A project
  // can still force confirmation via confirmationRequiredActions.
  softCommit: [
    "forward", "share", "publish", "post", "upload", "invite",
    "save", "create"
  ],
  account: [
    "login", "logout", "signin", "signout", "register"
  ]
} as const;

const NON_COMMIT_CONTEXT = new Set(["search", "filter", "query"]);

function tokens(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function semanticStrings(
  proposal: ProposedStep,
  snapshot: RuntimeSnapshot
): string[] {
  if (
    proposal.action !== "click"
    && proposal.action !== "longClick"
  ) {
    return [];
  }
  const locator = proposal.locator;
  const locatorValues = [
    locator.resourceId,
    locator.text,
    locator.contentDescription
  ].filter((value): value is string => value !== undefined);
  const resolution = resolveLocator(snapshot.layout, locator, {
    requireEnabled: false
  });
  const element = resolution.status === "found"
    ? resolution.element
    : undefined;
  return [
    ...locatorValues,
    ...(element === undefined
      ? []
      : [
          element.resourceId,
          element.text,
          element.contentDescription
        ].filter((value): value is string => value !== undefined))
  ];
}

function semanticSideEffect(
  proposal: ProposedStep,
  snapshot: RuntimeSnapshot
): NonNullable<RiskEvaluation["semanticSideEffect"]> | undefined {
  const allTokens = semanticStrings(proposal, snapshot).flatMap(tokens);
  for (const category of ["destructive", "account"] as const) {
    const terms = SEMANTIC_TERMS[category];
    const matchedTerm = terms.find((term) => allTokens.includes(term));
    if (matchedTerm !== undefined) {
      return { category, matchedTerm };
    }
  }
  const matchedTerm = SEMANTIC_TERMS.hardCommit.find(
    (term) => allTokens.includes(term)
  );
  if (
    matchedTerm === "submit"
    && allTokens.some((token) => NON_COMMIT_CONTEXT.has(token))
  ) {
    return undefined;
  }
  if (matchedTerm !== undefined) {
    return { category: "hardCommit", matchedTerm };
  }
  return undefined;
}

export class RiskEvaluator {
  public evaluate(
    actionOrProposal: ProposedStep["action"] | ProposedStep,
    policy: InteractionPolicy,
    snapshot?: RuntimeSnapshot
  ): RiskEvaluation {
    const action = typeof actionOrProposal === "string"
      ? actionOrProposal
      : actionOrProposal.action;
    if (action === "bridge") {
      return { effectiveRisk: "safe" };
    }
    if (policy.forbiddenActions.includes(action)) {
      return { effectiveRisk: "forbidden" };
    }
    if (policy.confirmationRequiredActions.includes(action)) {
      return { effectiveRisk: "confirmationRequired" };
    }
    if (policy.allowedActions.includes(action)) {
      if (typeof actionOrProposal !== "string" && snapshot !== undefined) {
        const semantic = semanticSideEffect(actionOrProposal, snapshot);
        if (semantic !== undefined) {
          return {
            effectiveRisk: "confirmationRequired",
            semanticSideEffect: semantic
          };
        }
      }
      return { effectiveRisk: "safe" };
    }
    return { effectiveRisk: "confirmationRequired" };
  }
}
