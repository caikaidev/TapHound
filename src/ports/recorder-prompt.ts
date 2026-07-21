export type RecorderAction =
  | "click"
  | "longClick"
  | "inputText"
  | "swipe"
  | "scrollTo"
  | "back"
  | "wait"
  | "finish"
  | "cancel";

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
}
