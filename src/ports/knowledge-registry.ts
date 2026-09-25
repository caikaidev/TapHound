import type {
  AnchorDefinition,
  KnowledgeBundleIndex,
  ScreenDefinition
} from "../domain/knowledge.js";

export interface LoadedKnowledgeBundle {
  index: KnowledgeBundleIndex;
  indexSha256: string;
  knowledgeHash: string;
  anchors: AnchorDefinition[];
  screens: ScreenDefinition[];
}

export interface KnowledgeRehashResult {
  indexPath: string;
  knowledgeHash: string;
  revision: number;
  changed: boolean;
  anchors: number;
  screens: number;
}

export interface KnowledgeRegistryPort {
  load: (projectRoot: string) => Promise<LoadedKnowledgeBundle>;
  rehash: (
    projectRoot: string,
    packageName: string
  ) => Promise<KnowledgeRehashResult>;
}
