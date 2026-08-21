import { legacyWorkspaceMessage } from "../domain/workspace.js";
import type { CliDependencies } from "./dependencies.js";

export async function assertNoLegacyWorkspace(
  dependencies: Pick<CliDependencies, "workspaceLayout">,
  projectRoot: string
): Promise<void> {
  const legacy = await dependencies.workspaceLayout.findLegacyDirectories(
    projectRoot
  );
  if (legacy.length > 0) {
    throw new Error(legacyWorkspaceMessage(legacy));
  }
  await dependencies.workspaceLayout.ensureBuildLayout(projectRoot);
}
