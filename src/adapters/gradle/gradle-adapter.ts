import type {
  GradleBuildOptions,
  GradlePort
} from "../../ports/gradle.js";
import type {
  CommandResult,
  ProcessRunner
} from "../../ports/process-runner.js";

export class GradleAdapter implements GradlePort {
  public constructor(private readonly runner: ProcessRunner) {}

  public build(options: GradleBuildOptions): Promise<CommandResult> {
    return this.runner.run({
      executable: "./gradlew",
      args: [options.task],
      cwd: options.projectDir,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
}
