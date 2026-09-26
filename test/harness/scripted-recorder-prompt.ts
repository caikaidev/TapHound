import type { BridgeScenario } from "../../src/domain/journey.js";
import type {
  ExternalStepAction,
  RecorderPromptPort,
  RecorderTargetChoice,
  ScrollDecision,
  SwipeOptions
} from "../../src/ports/recorder-prompt.js";

/** One external-app move inside a recorded bridge. */
export type ExternalMove =
  | { action: "click" | "longClick"; target: string }
  | { action: "inputText"; text: string }
  | { action: "back" | "wait" | "finishExternal" };

/** One move a person makes in `taphound record`, by Layout element id. */
export type RecordMove =
  | { action: "click" | "longClick"; target: string }
  | { action: "inputText"; text: string }
  | { action: "back" | "wait" }
  | {
      action: "bridgeTrigger";
      scenario: BridgeScenario;
      description: string;
      returnTimeoutMs: number;
      target: string;
      /** Moves inside the escaped app; leaving it ends the list. */
      external: readonly ExternalMove[];
    };

class Queue<T> {
  private readonly items: T[] = [];
  public constructor(private readonly name: string) {}
  public push(item: T): void {
    this.items.push(item);
  }
  public next(): T {
    const item = this.items.shift();
    if (item === undefined) {
      throw new Error(`Recorder script has no answer left for ${this.name}`);
    }
    return item;
  }
}

/**
 * Answers the Recorder's prompts from a fixed script, the way a person
 * would: pick an action, then the named Layout element. Failures the
 * Recorder reports are kept for assertions instead of being shown.
 */
export class ScriptedRecorderPrompt implements RecorderPromptPort {
  public readonly failures: string[] = [];
  private readonly actions = new Queue<RecordMove["action"] | "finish">("selectAction");
  private readonly targets = new Queue<string>("selectTarget");
  private readonly texts = new Queue<string>("inputText");
  private readonly scenarios = new Queue<BridgeScenario>("selectBridgeScenario");
  private readonly descriptions = new Queue<string>("inputBridgeDescription");
  private readonly returnTimeouts = new Queue<number>("inputBridgeReturnTimeoutMs");
  private readonly externalActions = new Queue<ExternalStepAction>("selectExternalStepAction");

  public constructor(moves: readonly RecordMove[]) {
    for (const move of moves) {
      this.actions.push(move.action);
      this.answer(move);
    }
    this.actions.push("finish");
  }

  public selectAction = (): Promise<RecordMove["action"] | "finish"> => (
    Promise.resolve(this.actions.next())
  );

  public selectTarget = (
    choices: readonly RecorderTargetChoice[]
  ): Promise<string> => {
    const id = this.targets.next();
    if (!choices.some((choice) => choice.id === id)) {
      throw new Error(`Recorder did not offer target ${id}: ${
        choices.map((choice) => choice.id).join(", ")
      }`);
    }
    return Promise.resolve(id);
  };

  public inputText = (): Promise<string> => Promise.resolve(this.texts.next());
  public selectSwipeDirection = (): Promise<"up"> => Promise.resolve("up");
  public longClickDuration = (): Promise<number> => Promise.resolve(800);
  public swipeOptions = (): Promise<SwipeOptions> => (
    Promise.resolve({ distancePercent: 50, durationMs: 300 })
  );
  public selectFallbackLabel = (): Promise<undefined> => Promise.resolve(undefined);

  public notifyFailure = (message: string): Promise<void> => {
    this.failures.push(message);
    return Promise.resolve();
  };

  public selectScrollContainer = (): Promise<string> => (
    Promise.reject(new Error("Recorder script does not scroll"))
  );
  public scrollTargetDecision = (): Promise<ScrollDecision> => (
    Promise.resolve({ kind: "cancel" })
  );
  public selectBridgeScenario = (): Promise<BridgeScenario> => (
    Promise.resolve(this.scenarios.next())
  );
  public inputBridgeDescription = (): Promise<string> => (
    Promise.resolve(this.descriptions.next())
  );
  public inputBridgeReturnTimeoutMs = (): Promise<number> => (
    Promise.resolve(this.returnTimeouts.next())
  );
  public selectExternalStepAction = (): Promise<ExternalStepAction> => (
    Promise.resolve(this.externalActions.next())
  );
  public notifyExternalEscape = (): Promise<void> => Promise.resolve();
  public notifyExternalReturn = (): Promise<void> => Promise.resolve();
  public notifyBridgeNoEscape = (): Promise<void> => {
    this.failures.push("bridge trigger did not escape");
    return Promise.resolve();
  };

  private answer(move: RecordMove | ExternalMove): void {
    if (move.action === "click" || move.action === "longClick") {
      this.targets.push(move.target);
    } else if (move.action === "inputText") {
      this.texts.push(move.text);
    } else if (move.action === "bridgeTrigger") {
      this.scenarios.push(move.scenario);
      this.descriptions.push(move.description);
      this.returnTimeouts.push(move.returnTimeoutMs);
      this.targets.push(move.target);
      for (const external of move.external) {
        this.externalActions.push(external.action);
        this.answer(external);
      }
    }
  }
}
