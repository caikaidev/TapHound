import type { WorkspaceLayoutPort } from "../../src/ports/workspace-layout.js";

export interface FakeWorkspaceLayout extends WorkspaceLayoutPort {
  legacyDirectories: string[];
  ignoredProjects: string[];
}

export function fakeWorkspaceLayout(
  legacyDirectories: readonly string[] = []
): FakeWorkspaceLayout {
  const layout: FakeWorkspaceLayout = {
    legacyDirectories: [...legacyDirectories],
    ignoredProjects: [],
    findLegacyDirectories: (): Promise<readonly string[]> => (
      Promise.resolve(layout.legacyDirectories)
    ),
    ensureBuildIgnored: (projectRoot): Promise<void> => {
      layout.ignoredProjects.push(projectRoot);
      return Promise.resolve();
    }
  };
  return layout;
}
