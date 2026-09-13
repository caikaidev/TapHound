import type {
  FalseDoneCase,
  FalseDoneRunResult
} from "../domain/false-done.js";

export interface FalseDoneStore {
  readCases: (
    projectRoot: string,
    caseIds?: readonly string[]
  ) => Promise<readonly FalseDoneCase[]>;
  writeResult: (input: {
    projectRoot: string;
    result: FalseDoneRunResult;
  }) => Promise<string>;
  readResult: (
    projectRoot: string,
    runId: string
  ) => Promise<FalseDoneRunResult>;
}