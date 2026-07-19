import type { CommandResult } from "./process-runner.js";

export interface GradleBuildOptions {
  projectDir: string;
  task: string;
  signal?: AbortSignal | undefined;
}

export interface GradlePort {
  build(options: GradleBuildOptions): Promise<CommandResult>;
}
