import type { CliDependencies } from "./dependencies.js";

export async function prepareWorkspace(
  dependencies: Pick<CliDependencies, "workspaceLayout">,
  projectRoot: string
): Promise<void> {
  await dependencies.workspaceLayout.ensureBuildLayout(projectRoot);
}
