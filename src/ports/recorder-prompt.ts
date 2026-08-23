import type { BridgeScenario } from "../domain/journey.js";

export type RecorderAction =
  | "click"
  | "longClick"
  | "inputText"
  | "swipe"
  | "scrollTo"
  | "back"
  | "wait"
  | "bridgeTrigger"
  | "finish"
  | "cancel";

export type ExternalStepAction =
  | "click"
  | "longClick"
  | "inputText"
  | "swipe"
  | "scrollTo"
  | "back"
  | "wait"
  | "finishExternal";

export type ScrollDecision =
  | { kind: "select"; id: string }
  | { kind: "scrollMore" }
  | { kind: "cancel" };

export interface RecorderTargetChoice {
  id: string;
  label: string;
}

export interface SwipeOptions {
  distancePercent: number;
  durationMs: number;
}

export interface RecorderPromptPort {
  selectAction: () => Promise<RecorderAction>;
  selectTarget: (
    choices: readonly RecorderTargetChoice[]
  ) => Promise<string>;
  inputText: () => Promise<string>;
  selectSwipeDirection: () => Promise<"up" | "down" | "left" | "right">;
  longClickDuration: () => Promise<number>;
  swipeOptions: () => Promise<SwipeOptions>;
  selectFallbackLabel: (
    annotatedScreenshotPath: string
  ) => Promise<string | undefined>;
  notifyFailure: (message: string) => Promise<void>;
  selectScrollContainer: (
    choices: readonly RecorderTargetChoice[]
  ) => Promise<string>;
  scrollTargetDecision: (
    choices: readonly RecorderTargetChoice[]
  ) => Promise<ScrollDecision>;
  selectBridgeScenario: () => Promise<BridgeScenario>;
  inputBridgeDescription: (scenario: BridgeScenario) => Promise<string>;
  inputBridgeReturnTimeoutMs: () => Promise<number>;
  selectExternalStepAction: () => Promise<ExternalStepAction>;
  notifyExternalEscape: (escapedPackageName: string) => Promise<void>;
  notifyExternalReturn: () => Promise<void>;
  notifyBridgeNoEscape: () => Promise<void>;
}
