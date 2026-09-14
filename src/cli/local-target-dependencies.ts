import { resolve as resolvePath } from "node:path";

import {
  FileSystemLocalTargetWorkspace,
  type LocalTargetWorkspacePort
} from "../adapters/filesystem/local-target-workspace.js";
import { FileSystemTargetConfigStore } from "../adapters/filesystem/target-config-store.js";
import { NodeLocalAssetSync } from "../adapters/filesystem/local-asset-sync.js";
import { TargetPathResolver } from "../adapters/filesystem/target-path-resolver.js";
import { NodeTargetProjectInspector } from "../adapters/filesystem/target-project-inspector.js";
import { LocalSyncService, type LocalSyncResult } from "../application/target/local-sync-service.js";
import { LocalTargetService } from "../application/target/local-target-service.js";
import { TargetResolver } from "../application/target/target-resolver.js";
import type {
  LocalTargetIdentity,
  ProjectFingerprint
} from "../domain/target.js";
import type { TargetPathResolverPort } from "../ports/path-resolver.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { TargetConfigStorePort } from "../ports/target-config-store.js";

export interface LocalSyncPort {
  sync: (input: {
    targetId: string;
    projectRoot: string;
    targetsHome: string;
  }) => Promise<LocalSyncResult>;
}

export interface LocalTargets {
  targetsHome: () => string;
  configStore: TargetConfigStorePort;
  pathResolver: TargetPathResolverPort;
  workspace: LocalTargetWorkspacePort;
  localSync: LocalSyncPort;
  targetResolver: (targetsHome: string) => TargetResolver;
  localTargetService: (targetsHome: string) => LocalTargetService;
  processRunner: ProcessRunner;
  clock: { now: () => Date };
}

export function createLocalTargets(
  runner: ProcessRunner,
  clock: { now: () => Date }
): LocalTargets {
  const configStore = new FileSystemTargetConfigStore();
  const pathResolver = new TargetPathResolver({ env: process.env });
  const workspace = new FileSystemLocalTargetWorkspace();
  const projectInspector = new NodeTargetProjectInspector();
  const makeResolver = (targetsHome: string): TargetResolver => new TargetResolver({
    targetsHome,
    configStore,
    pathResolver,
    processRunner: runner,
    projectInspector,
    clock
  });
  const localSync = new LocalSyncService({
    workspaceRoot: (targetsHome: string, targetId: string): string =>
      workspace.root(targetsHome, targetId),
    assetSync: new NodeLocalAssetSync()
  });
  return {
    targetsHome: (): string => {
      const explicit = process.env.TAPHOUND_TARGETS_HOME;
      return explicit === undefined
        ? process.cwd()
        : resolvePath(process.cwd(), explicit);
    },
    configStore,
    pathResolver,
    workspace,
    targetResolver: makeResolver,
    localSync,
    localTargetService: (
      targetsHome: string
    ): LocalTargetService => new LocalTargetService({
      identityStore: {
        readIdentity: async (
          targetId: string
        ): Promise<LocalTargetIdentity | null> => (
          workspace.readIdentity(targetsHome, targetId)
        ),
        writeIdentity: async (
          identity: LocalTargetIdentity
        ): Promise<void> => (
          workspace.writeIdentity(targetsHome, identity.targetId, identity)
        ),
        ensureWorkspace: async (targetId: string): Promise<void> => (
          workspace.ensureWorkspace(targetsHome, targetId)
        )
      },
      fingerprint: (
        project,
        packageName?: string
      ): Promise<Pick<ProjectFingerprint, "hash">> => (
        makeResolver(targetsHome).fingerprint(project, packageName)
      )
    }),
    processRunner: runner,
    clock
  };
}
