import type { ChangeSet } from "../domain/impact.js";

export interface GitDiffPort {
  diff: (input: {
    projectRoot: string;
    base: string;
    head: string;
    signal?: AbortSignal | undefined;
  }) => Promise<ChangeSet>;
}