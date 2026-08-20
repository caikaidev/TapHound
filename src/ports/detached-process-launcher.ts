export interface DetachedProcessInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface DetachedProcessLauncher {
  launch: (input: DetachedProcessInput) => Promise<{ pid: number }>;
}
