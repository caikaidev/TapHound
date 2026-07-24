export interface ProjectBoundPath {
  projectRoot: string;
  authorityRoot: string;
  outputPath: string;
}

export interface ProjectBoundFileReader {
  readProjectBound: (path: ProjectBoundPath) => Promise<Buffer>;
}
