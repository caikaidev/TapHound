import type { WorkspaceLayoutPort } from "../../src/ports/workspace-layout.js";

export interface FakeWorkspaceLayout extends WorkspaceLayoutPort {
  ignoredProjects: string[];
  initializedProjects: string[];
}

export function fakeWorkspaceLayout(): FakeWorkspaceLayout {
  const layout: FakeWorkspaceLayout = {
    ignoredProjects: [],
    initializedProjects: [],
    ensureBuildIgnored: (projectRoot): Promise<void> => {
      layout.ignoredProjects.push(projectRoot);
      return Promise.resolve();
    },
    ensureBuildLayout: (projectRoot): Promise<void> => {
      layout.initializedProjects.push(projectRoot);
      return Promise.resolve();
    }
  };
  return layout;
}
