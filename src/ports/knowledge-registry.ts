import type {
  AnchorDefinition,
  KnowledgeBundleIndex,
  ScreenDefinition,
  TransitionDefinition
} from "../domain/knowledge.js";

export interface LoadedKnowledgeBundle {
  index: KnowledgeBundleIndex;
  indexSha256: string;
  knowledgeHash: string;
  anchors: AnchorDefinition[];
  screens: ScreenDefinition[];
  transitions: TransitionDefinition[];
}

export interface WriteKnowledgeBundleInput {
  projectRoot: string;
  packageName: string;
  expectedKnowledgeHash?: string | undefined;
  anchors: readonly AnchorDefinition[];
  screens: readonly ScreenDefinition[];
  transitions: readonly TransitionDefinition[];
}

export interface WriteKnowledgeBundleResult {
  indexPath: string;
  knowledgeHash: string;
  revision: number;
}

export interface KnowledgeRegistryPort {
  load: (
    projectRoot: string,
    workspaceRoot?: string  
  ) => Promise<LoadedKnowledgeBundle>;
  writePromoted: (
    input: WriteKnowledgeBundleInput
  ) => Promise<WriteKnowledgeBundleResult>;
}
