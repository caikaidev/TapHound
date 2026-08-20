import type {
  ContextSelection,
  ProjectContext,
  ProjectContextModule,
  ResolvedProjectContext
} from "../../src/domain/project-context.js";

export const contextSelection: ContextSelection = {
  bundleVersion: 2,
  indexHash: "f".repeat(64),
  modules: [{
    id: ":app",
    sha256: "e".repeat(64),
    projectDir: "app",
    inventory: {
      pathSetSha256: "c".repeat(64),
      categories: ["manifests", "sources", "layouts", "navigation"]
    }
  }]
};

export const projectContextIndex: ProjectContext = {
  version: 2,
  packageName: "com.example.app",
  launchActivity: "com.example.app.MainActivity",
  manifest: {
    version: 1,
    files: [{
      path: "settings.gradle.kts",
      sha256: "d".repeat(64),
      confidence: "sourceConfirmed"
    }]
  },
  interactionPolicy: {
    allowedActions: ["click", "inputText", "back", "wait"],
    confirmationRequiredActions: [],
    forbiddenActions: []
  },
  modules: [{
    id: ":app",
    projectDir: "app",
    kind: "application",
    contextPath: ".taphound/context/modules/app.json",
    sha256: "e".repeat(64),
    features: ["launch", "home"],
    activities: ["com.example.app.MainActivity"],
    dependsOn: [],
    status: "complete"
  }]
};

export const projectContextModule: ProjectContextModule = {
  version: 2,
  moduleId: ":app",
  projectDir: "app",
  status: "complete",
  inventory: {
    version: 2,
    pathSetSha256: "c".repeat(64),
    categories: ["manifests", "sources", "layouts", "navigation"]
  },
  manifest: {
    version: 1,
    files: [{
      path: "app/src/main/AndroidManifest.xml",
      sha256: "a".repeat(64),
      confidence: "sourceConfirmed"
    }]
  },
  summary: {
    features: ["launch", "home"],
    activities: [{
      name: "com.example.app.MainActivity",
      entryPoints: [],
      screens: ["home"]
    }],
    elements: [{
      screen: "home",
      resourceId: "search",
      actions: ["click"]
    }],
    transitions: [],
    logcat: []
  }
};

export const resolvedProjectContext: ResolvedProjectContext = {
  version: 2,
  packageName: projectContextIndex.packageName,
  launchActivity: projectContextIndex.launchActivity,
  manifest: {
    version: 1,
    files: [
      ...projectContextIndex.manifest.files,
      ...projectContextModule.manifest.files
    ]
  },
  interactionPolicy: projectContextIndex.interactionPolicy,
  selection: contextSelection
};
