import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type RemoteDirectoryProgressPhase = "scanning" | "reading" | "done";

type RemoteDirectoryProgressEvent = {
  operationId: string;
  phase: RemoteDirectoryProgressPhase;
  completed: number;
  total: number;
  percent: number;
  currentPath: string | null;
};

type DirectoryCopyProgress = {
  operationId: string;
  phase: RemoteDirectoryProgressPhase;
  completed: number;
  total: number;
  percent: number;
  currentPath: string | null;
};

type CodeFileEntry = {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
};

type ExplorerView = "local" | "remote";

type LoadedCodeFile = CodeFileEntry & {
  content: string;
};

type DependencyGraph = {
  dependenciesByFile: Map<string, Set<string>>;
  dependentsByFile: Map<string, Set<string>>;
};

const IMPORT_SPECIFIER_REGEXES = [
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /@import\s+(?:url\()?["']([^"']+)["']\)?/g,
];

const RESOLVABLE_IMPORT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".md",
  ".mdx",
  ".prisma",
];

function stripImportSuffix(specifier: string): string {
  return specifier.split("?")[0]?.split("#")[0]?.trim() ?? specifier.trim();
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeRootPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isRemoteRootPath(rootPath: string): boolean {
  return normalizeRootPath(rootPath).startsWith("ssh://");
}

function dirnameFromRelativePath(relativePath: string): string {
  const normalizedPath = normalizeRelativePath(relativePath);
  const slashIndex = normalizedPath.lastIndexOf("/");

  if (slashIndex === -1) return "";

  return normalizedPath.slice(0, slashIndex);
}

function joinRelativePath(baseDirectory: string, importPath: string): string {
  const parts = `${baseDirectory}/${importPath}`
    .split("/")
    .filter((part) => part.length > 0);

  const resolvedParts: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;

    if (part === "..") {
      resolvedParts.pop();
      continue;
    }

    resolvedParts.push(part);
  }

  return resolvedParts.join("/");
}

function getImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();

  for (const regex of IMPORT_SPECIFIER_REGEXES) {
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const specifier = match[1]?.trim();

      if (specifier) {
        specifiers.add(stripImportSuffix(specifier));
      }
    }
  }

  return [...specifiers];
}

function buildImportResolutionCandidates(
  sourceRelativePath: string,
  specifier: string
): string[] {
  const cleanedSpecifier = stripImportSuffix(specifier);

  if (!cleanedSpecifier) return [];

  let baseCandidate: string | null = null;

  if (cleanedSpecifier.startsWith(".")) {
    baseCandidate = joinRelativePath(
      dirnameFromRelativePath(sourceRelativePath),
      cleanedSpecifier
    );
  } else if (cleanedSpecifier.startsWith("@/")) {
    baseCandidate = normalizeRelativePath(`src/${cleanedSpecifier.slice(2)}`);
  } else {
    return [];
  }

  const candidates = new Set<string>();

  candidates.add(normalizeRelativePath(baseCandidate));

  for (const extension of RESOLVABLE_IMPORT_EXTENSIONS) {
    candidates.add(normalizeRelativePath(`${baseCandidate}${extension}`));
  }

  for (const extension of RESOLVABLE_IMPORT_EXTENSIONS) {
    candidates.add(normalizeRelativePath(`${baseCandidate}/index${extension}`));
  }

  return [...candidates];
}

function resolveImportSpecifier(
  sourceRelativePath: string,
  specifier: string,
  relativePathSet: Set<string>
): string | null {
  const candidates = buildImportResolutionCandidates(
    sourceRelativePath,
    specifier
  );

  for (const candidate of candidates) {
    if (relativePathSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildDependencyGraph(files: LoadedCodeFile[]): DependencyGraph {
  const relativePathSet = new Set(
    files.map((file) => normalizeRelativePath(file.relativePath))
  );

  const dependenciesByFile = new Map<string, Set<string>>();
  const dependentsByFile = new Map<string, Set<string>>();

  for (const file of files) {
    const sourceRelativePath = normalizeRelativePath(file.relativePath);

    if (!dependenciesByFile.has(sourceRelativePath)) {
      dependenciesByFile.set(sourceRelativePath, new Set());
    }

    if (!dependentsByFile.has(sourceRelativePath)) {
      dependentsByFile.set(sourceRelativePath, new Set());
    }
  }

  for (const file of files) {
    const sourceRelativePath = normalizeRelativePath(file.relativePath);
    const specifiers = getImportSpecifiers(file.content);

    for (const specifier of specifiers) {
      const resolvedRelativePath = resolveImportSpecifier(
        sourceRelativePath,
        specifier,
        relativePathSet
      );

      if (!resolvedRelativePath || resolvedRelativePath === sourceRelativePath) {
        continue;
      }

      if (!dependenciesByFile.has(sourceRelativePath)) {
        dependenciesByFile.set(sourceRelativePath, new Set());
      }

      if (!dependentsByFile.has(resolvedRelativePath)) {
        dependentsByFile.set(resolvedRelativePath, new Set());
      }

      dependenciesByFile.get(sourceRelativePath)?.add(resolvedRelativePath);
      dependentsByFile.get(resolvedRelativePath)?.add(sourceRelativePath);
    }
  }

  return {
    dependenciesByFile,
    dependentsByFile,
  };
}

function getDirectLinkedRelativePaths(
  graph: DependencyGraph,
  sourceRelativePath: string
): string[] {
  const normalizedSourceRelativePath = normalizeRelativePath(sourceRelativePath);
  const linkedPaths = new Set<string>();

  for (const dependencyPath of graph.dependenciesByFile.get(
    normalizedSourceRelativePath
  ) ?? []) {
    linkedPaths.add(dependencyPath);
  }

  for (const dependentPath of graph.dependentsByFile.get(
    normalizedSourceRelativePath
  ) ?? []) {
    linkedPaths.add(dependentPath);
  }

  linkedPaths.delete(normalizedSourceRelativePath);

  return [...linkedPaths].sort((a, b) => a.localeCompare(b));
}

type SelectedPromptFile = CodeFileEntry & {
  content: string;
  charCount: number;
  addedAt: number;
};

type FileTreeNode = {
  type: "file";
  name: string;
  path: string;
  file: CodeFileEntry;
};

type DirectoryTreeNode = {
  type: "directory";
  name: string;
  path: string;
  children: TreeNode[];
};

type TreeNode = FileTreeNode | DirectoryTreeNode;

type MutableDirectoryNode = {
  name: string;
  path: string;
  directories: Map<string, MutableDirectoryNode>;
  files: FileTreeNode[];
};

type ProjectTab = {
  id: string;
  rootPath: string;
  name: string;
  files: CodeFileEntry[];
  selectedFiles: SelectedPromptFile[];
  pendingSelectedPaths: string[];
  activePath: string | null;
  query: string;
  personalPrompt: string;
  expandedDirectoryPaths: string[];
  lastScannedAt: number | null;
};

type PersistedProjectTab = {
  id: string;
  rootPath: string;
  name: string;
  selectedFilePaths: string[];
  activePath: string | null;
  query: string;
  personalPrompt: string;
  expandedDirectoryPaths: string[];
};

type PersistedProjectState = {
  activeProjectId: string | null;
  tabs: PersistedProjectTab[];
};

const PROJECT_STORAGE_KEY = "promptpad.project-tabs.v1";

function getProjectName(rootPath: string): string {
  const normalizedPath = normalizeRootPath(rootPath);
  const parts = normalizedPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalizedPath;
}

function createProjectId(rootPath: string): string {
  const randomValue =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${getProjectName(rootPath)}-${randomValue}`;
}

function buildPromptOutput(
  personalPrompt: string,
  files: SelectedPromptFile[]
): string {
  const blocks: string[] = [];

  const trimmedPersonalPrompt = personalPrompt.trim();

  if (trimmedPersonalPrompt) {
    blocks.push(`personal-prompt.md\n${trimmedPersonalPrompt}`);
  }

  blocks.push(
    ...files.map((file) => {
      const relativePath = normalizeRelativePath(file.relativePath);
      return `${relativePath}\n${file.content.trimEnd()}`;
    })
  );

  return blocks.join("\n\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatLastScannedAt(value: number | null): string {
  if (!value) return "Not scanned yet";
  return new Date(value).toLocaleString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createMutableDirectory(
  name: string,
  path: string
): MutableDirectoryNode {
  return {
    name,
    path,
    directories: new Map<string, MutableDirectoryNode>(),
    files: [],
  };
}

function buildFileTree(files: CodeFileEntry[]): TreeNode[] {
  const root = createMutableDirectory("", "");

  for (const file of files) {
    const normalizedRelativePath = normalizeRelativePath(file.relativePath);
    const parts = normalizedRelativePath.split("/").filter(Boolean);

    if (parts.length === 0) continue;

    let currentDirectory = root;

    for (const directoryName of parts.slice(0, -1)) {
      const directoryPath = currentDirectory.path
        ? `${currentDirectory.path}/${directoryName}`
        : directoryName;

      const existingDirectory =
        currentDirectory.directories.get(directoryName) ??
        createMutableDirectory(directoryName, directoryPath);

      currentDirectory.directories.set(directoryName, existingDirectory);
      currentDirectory = existingDirectory;
    }

    const fileName = parts[parts.length - 1];

    currentDirectory.files.push({
      type: "file",
      name: fileName,
      path: normalizedRelativePath,
      file,
    });
  }

  function toTreeNodes(directory: MutableDirectoryNode): TreeNode[] {
    const directories: DirectoryTreeNode[] = Array.from(
      directory.directories.values()
    )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((childDirectory) => ({
        type: "directory",
        name: childDirectory.name,
        path: childDirectory.path,
        children: toTreeNodes(childDirectory),
      }));

    const fileNodes = directory.files.sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return [...directories, ...fileNodes];
  }

  return toTreeNodes(root);
}

function createProjectTab(rootPath: string, files: CodeFileEntry[]): ProjectTab {
  return {
    id: createProjectId(rootPath),
    rootPath,
    name: getProjectName(rootPath),
    files,
    selectedFiles: [],
    pendingSelectedPaths: [],
    activePath: null,
    query: "",
    personalPrompt: "",
    expandedDirectoryPaths: [],
    lastScannedAt: Date.now(),
  };
}

function parsePersistedProjectState(): PersistedProjectState {
  const fallback: PersistedProjectState = {
    activeProjectId: null,
    tabs: [],
  };

  try {
    const rawValue = localStorage.getItem(PROJECT_STORAGE_KEY);

    if (!rawValue) return fallback;

    const parsedValue = JSON.parse(rawValue) as Partial<PersistedProjectState>;

    if (!Array.isArray(parsedValue.tabs)) return fallback;

    const tabs = parsedValue.tabs
      .filter(
        (tab): tab is PersistedProjectTab =>
          typeof tab?.rootPath === "string" && tab.rootPath.trim().length > 0
      )
      .map((tab) => ({
        id:
          typeof tab.id === "string" && tab.id.trim()
            ? tab.id
            : createProjectId(tab.rootPath),
        rootPath: tab.rootPath,
        name:
          typeof tab.name === "string" && tab.name.trim()
            ? tab.name
            : getProjectName(tab.rootPath),
        selectedFilePaths: Array.isArray(tab.selectedFilePaths)
          ? tab.selectedFilePaths.filter(
              (path): path is string => typeof path === "string"
            )
          : [],
        activePath:
          typeof tab.activePath === "string" && tab.activePath.trim()
            ? tab.activePath
            : null,
        query: typeof tab.query === "string" ? tab.query : "",
        personalPrompt:
          typeof tab.personalPrompt === "string" ? tab.personalPrompt : "",
        expandedDirectoryPaths: Array.isArray(tab.expandedDirectoryPaths)
          ? tab.expandedDirectoryPaths.filter(
              (path): path is string => typeof path === "string"
            )
          : [],
      }));

    const activeProjectId =
      typeof parsedValue.activeProjectId === "string" &&
      tabs.some((tab) => tab.id === parsedValue.activeProjectId)
        ? parsedValue.activeProjectId
        : tabs[0]?.id ?? null;

    return {
      activeProjectId,
      tabs,
    };
  } catch {
    return fallback;
  }
}

function toRuntimeProjectTab(tab: PersistedProjectTab): ProjectTab {
  const remoteProject = isRemoteRootPath(tab.rootPath);

  return {
    id: tab.id,
    rootPath: tab.rootPath,
    name: tab.name,
    files: [],
    selectedFiles: [],
    pendingSelectedPaths: remoteProject ? [] : tab.selectedFilePaths,
    activePath: remoteProject ? null : tab.activePath,
    query: tab.query,
    personalPrompt: tab.personalPrompt,
    expandedDirectoryPaths: tab.expandedDirectoryPaths,
    lastScannedAt: remoteProject ? Date.now() : null,
  };
}

function toPersistedProjectState(
  tabs: ProjectTab[],
  activeProjectId: string | null
): PersistedProjectState {
  return {
    activeProjectId,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      rootPath: tab.rootPath,
      name: tab.name,
      selectedFilePaths:
        tab.selectedFiles.length > 0
          ? tab.selectedFiles.map((file) => file.path)
          : tab.pendingSelectedPaths,
      activePath: tab.activePath,
      query: tab.query,
      personalPrompt: tab.personalPrompt,
      expandedDirectoryPaths: tab.expandedDirectoryPaths,
    })),
  };
}

async function scanDirectory(rootPath: string): Promise<CodeFileEntry[]> {
  return invoke<CodeFileEntry[]>("scan_directory", {
    rootPath,
  });
}

async function readSelectedFilesFromDisk(
  rootPath: string,
  scannedFiles: CodeFileEntry[],
  selectedPaths: string[]
): Promise<SelectedPromptFile[]> {
  const scannedFileByPath = new Map(
    scannedFiles.map((file) => [file.path, file])
  );

  const uniqueSelectedPaths = Array.from(new Set(selectedPaths));

  const selectedFiles = await Promise.all(
    uniqueSelectedPaths.map(async (path) => {
      const scannedFile = scannedFileByPath.get(path);

      if (!scannedFile) return null;

      try {
        const content = await invoke<string>("read_code_file", {
          rootPath,
          filePath: scannedFile.path,
        });

        return {
          ...scannedFile,
          relativePath: normalizeRelativePath(scannedFile.relativePath),
          content,
          charCount: content.length,
          addedAt: Date.now(),
        } satisfies SelectedPromptFile;
      } catch {
        return null;
      }
    })
  );

  return selectedFiles.filter(
    (file): file is SelectedPromptFile => file !== null
  );
}

function countFilesInTreeNode(node: TreeNode): number {
  if (node.type === "file") return 1;

  return node.children.reduce(
    (total, childNode) => total + countFilesInTreeNode(childNode),
    0
  );
}

function countSelectedFilesInTreeNode(
  node: TreeNode,
  selectedPaths: Set<string>
): number {
  if (node.type === "file") {
    return selectedPaths.has(node.file.path) ? 1 : 0;
  }

  return node.children.reduce(
    (total, childNode) =>
      total + countSelectedFilesInTreeNode(childNode, selectedPaths),
    0
  );
}

function getFilesInDirectory(
  files: CodeFileEntry[],
  directoryPath: string
): CodeFileEntry[] {
  const normalizedDirectoryPath = normalizeRelativePath(directoryPath);
  const directoryPrefix = `${normalizedDirectoryPath}/`;

  return files.filter((file) =>
    normalizeRelativePath(file.relativePath).startsWith(directoryPrefix)
  );
}

type FileTreeProps = {
  nodes: TreeNode[];
  depth?: number;
  selectedPaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  searchActive: boolean;
  loadingFilePath: string | null;
  loadingFolderPath: string | null;
  loadingLinkedFilePath: string | null;
  onSelectLinkedFiles: (file: CodeFileEntry) => void;
  onToggleDirectory: (path: string) => void;
  onSelectDirectory: (directory: DirectoryTreeNode) => void;
  onSelectFile: (file: CodeFileEntry) => void;
};

function FileTree({
  nodes,
  depth = 0,
  selectedPaths,
  expandedDirectoryPaths,
  searchActive,
  loadingFilePath,
  loadingFolderPath,
  loadingLinkedFilePath,
  onToggleDirectory,
  onSelectDirectory,
  onSelectFile,
  onSelectLinkedFiles,
}: FileTreeProps) {
  return (
    <>
      {nodes.map((node) => {
        const rowStyle: CSSProperties = {
          paddingLeft: `${0.5 + depth * 0.9}rem`,
        };

        if (node.type === "directory") {
          const isExpanded =
            searchActive || expandedDirectoryPaths.has(node.path);

          const visibleFileCount = countFilesInTreeNode(node);
          const selectedVisibleFileCount = countSelectedFilesInTreeNode(
            node,
            selectedPaths
          );
          const isFullySelected =
            visibleFileCount > 0 && selectedVisibleFileCount === visibleFileCount;
          const isLoadingFolder = loadingFolderPath === node.path;

          return (
            <div key={node.path} className="tree-node">
              <div
                className={`tree-row tree-directory ${
                  isFullySelected ? "selected" : ""
                }`}
                style={rowStyle}
                title={node.path}
              >
                <button
                  type="button"
                  className="tree-expand-button"
                  onClick={() => onToggleDirectory(node.path)}
                  aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                >
                  <span className="tree-caret">{isExpanded ? "▾" : "▸"}</span>
                </button>

                <button
                  type="button"
                  className="tree-directory-main"
                  onClick={() => onToggleDirectory(node.path)}
                  title={node.path}
                >
                  <span className="tree-label">{node.name}</span>
                </button>

                <button
                  type="button"
                  className="tree-folder-add"
                  disabled={visibleFileCount === 0 || Boolean(loadingFolderPath)}
                  onClick={() => onSelectDirectory(node)}
                  title={`Add all files inside ${node.path}`}
                >
                  {isLoadingFolder
                    ? "Adding..."
                    : isFullySelected
                      ? "Added"
                      : `+ ${selectedVisibleFileCount}/${visibleFileCount}`}
                </button>
              </div>

              {isExpanded && (
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  selectedPaths={selectedPaths}
                  expandedDirectoryPaths={expandedDirectoryPaths}
                  searchActive={searchActive}
                  loadingFilePath={loadingFilePath}
                  loadingFolderPath={loadingFolderPath}
                  loadingLinkedFilePath={loadingLinkedFilePath}
                  onToggleDirectory={onToggleDirectory}
                  onSelectDirectory={onSelectDirectory}
                  onSelectFile={onSelectFile}
                  onSelectLinkedFiles={onSelectLinkedFiles}
                />
              )}
            </div>
          );
        }

        const isSelected = selectedPaths.has(node.file.path);
        const isLoading = loadingFilePath === node.file.path;
        const isLoadingLinked = loadingLinkedFilePath === node.file.path;

        return (
          <div
            key={node.path}
            className={`tree-row tree-file ${isSelected ? "selected" : ""}`}
            style={rowStyle}
            title={normalizeRelativePath(node.file.relativePath)}
          >
            <button
              type="button"
              className="tree-file-main"
              onClick={() => onSelectFile(node.file)}
              title={normalizeRelativePath(node.file.relativePath)}
            >
              <span className="tree-file-icon" />
              <span className="tree-label">{node.name}</span>
              <span className="tree-size">
                {isLoading ? "Loading..." : formatBytes(node.file.size)}
              </span>
            </button>

            {isSelected && (
              <button
                type="button"
                className="tree-linked-add"
                disabled={Boolean(loadingLinkedFilePath)}
                onClick={() => onSelectLinkedFiles(node.file)}
                title="Add files imported by this file and files that import this file"
              >
                {isLoadingLinked ? "Finding..." : "+ linked"}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

type SshAuthMode = "password" | "privateKey";

type SshCredentials = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
};

type RemoteFileEntry = {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
};

type RemoteFileContent = {
  path: string;
  content: string;
  size: number;
};

type RemoteDirectoryFileContent = {
  path: string;
  content: string;
  size: number;
};

type SshRemotePanelProps = {
  selectedPaths: Set<string>;
  onAddRemoteFile: (
    file: SelectedPromptFile,
    workspaceRootPath: string
  ) => void;
  onError: (message: string | null) => void;
  onToast: (message: string | null) => void;
  onLoading: (message: string | null) => void;
};

type SshFormState = {
  host: string;
  port: string;
  username: string;
  authMode: SshAuthMode;
  password: string;
  privateKeyPath: string;
  passphrase: string;
  remotePath: string;
};

const DEFAULT_SSH_FORM: SshFormState = {
  host: "",
  port: "22",
  username: "",
  authMode: "password",
  password: "",
  privateKeyPath: "",
  passphrase: "",
  remotePath: "/",
};

type SshConnectionProfile = {
  id: string;
  label: string;
  host: string;
  port: string;
  username: string;
  authMode: SshAuthMode;
  privateKeyPath: string;
  remotePath: string;
  lastUsedAt: number;
};

const SSH_CONNECTION_STORAGE_KEY = "promptpad:ssh-connections:v1";

function buildSshProfileId(profile: {
  host: string;
  port: string;
  username: string;
  authMode: SshAuthMode;
}): string {
  return [
    profile.authMode,
    profile.username.trim().toLowerCase(),
    profile.host.trim().toLowerCase(),
    profile.port.trim() || "22",
  ].join(":");
}

function buildSshProfileLabel(profile: {
  host: string;
  port: string;
  username: string;
}): string {
  return `${profile.username.trim()}@${profile.host.trim()}:${
    profile.port.trim() || "22"
  }`;
}

function createSshConnectionProfile(
  form: SshFormState
): SshConnectionProfile | null {
  const host = form.host.trim();
  const username = form.username.trim();
  const port = form.port.trim() || "22";

  if (!host || !username) return null;

  const baseProfile = {
    host,
    port,
    username,
    authMode: form.authMode,
  };

  return {
    ...baseProfile,
    id: buildSshProfileId(baseProfile),
    label: buildSshProfileLabel(baseProfile),
    privateKeyPath:
      form.authMode === "privateKey" ? form.privateKeyPath.trim() : "",
    remotePath: normalizeRemotePath(form.remotePath),
    lastUsedAt: Date.now(),
  };
}

function parsePersistedSshConnections(): SshConnectionProfile[] {
  try {
    const rawValue = localStorage.getItem(SSH_CONNECTION_STORAGE_KEY);
    if (!rawValue) return [];

    const parsedValue: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return [];

    return parsedValue
      .filter((profile): profile is SshConnectionProfile => {
        if (!profile || typeof profile !== "object") return false;

        const candidate = profile as Partial<SshConnectionProfile>;

        return (
          typeof candidate.id === "string" &&
          typeof candidate.label === "string" &&
          typeof candidate.host === "string" &&
          typeof candidate.port === "string" &&
          typeof candidate.username === "string" &&
          (candidate.authMode === "password" ||
            candidate.authMode === "privateKey") &&
          typeof candidate.privateKeyPath === "string" &&
          typeof candidate.remotePath === "string" &&
          typeof candidate.lastUsedAt === "number"
        );
      })
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

function upsertSshConnectionProfile(
  profiles: SshConnectionProfile[],
  nextProfile: SshConnectionProfile
): SshConnectionProfile[] {
  const dedupedProfiles = profiles.filter(
    (profile) => profile.id !== nextProfile.id
  );

  return [nextProfile, ...dedupedProfiles].slice(0, 20);
}

function applyProfileToSshForm(profile: SshConnectionProfile): SshFormState {
  return {
    host: profile.host,
    port: profile.port || "22",
    username: profile.username,
    authMode: profile.authMode,
    password: "",
    privateKeyPath: profile.privateKeyPath,
    passphrase: "",
    remotePath: profile.remotePath || "/",
  };
}

function normalizeRemotePath(path: string): string {
  const trimmedPath = path.trim();

  if (!trimmedPath) return "/";
  if (trimmedPath.startsWith("/")) return trimmedPath;

  return `/${trimmedPath}`;
}

function getRemoteParentPath(path: string): string {
  const normalizedPath = normalizeRemotePath(path).replace(/\/+$/, "");

  if (!normalizedPath || normalizedPath === "/") return "/";

  const slashIndex = normalizedPath.lastIndexOf("/");

  if (slashIndex <= 0) return "/";

  return normalizedPath.slice(0, slashIndex);
}

function getRemoteFileName(path: string): string {
  const normalizedPath = path.replace(/\/+$/, "");
  const parts = normalizedPath.split("/").filter(Boolean);

  return parts[parts.length - 1] ?? normalizedPath;
}

function getFileExtensionFromName(name: string): string {
  const dotIndex = name.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";

  return name.slice(dotIndex + 1).toLowerCase();
}

function buildSshCredentials(form: SshFormState): SshCredentials {
  const host = form.host.trim();
  const username = form.username.trim();
  const parsedPort = Number(form.port || "22");

  if (!host) {
    throw new Error("SSH host is required.");
  }

  if (!username) {
    throw new Error("SSH username is required.");
  }

  if (
    !Number.isInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65_535
  ) {
    throw new Error("SSH port must be a number between 1 and 65535.");
  }

  if (form.authMode === "password") {
    if (!form.password) {
      throw new Error("SSH password is required.");
    }

    return {
      host,
      username,
      port: parsedPort,
      password: form.password,
    };
  }

  const privateKeyPath = form.privateKeyPath.trim();

  if (!privateKeyPath) {
    throw new Error("Private key path is required.");
  }

  return {
    host,
    username,
    port: parsedPort,
    privateKeyPath,
    passphrase: form.passphrase || undefined,
  };
}

function buildRemoteWorkspaceRoot(credentials: SshCredentials): string {
  return `ssh://${credentials.username}@${credentials.host}:${
    credentials.port ?? 22
  }`;
}

function buildRemotePromptPath(
  credentials: SshCredentials,
  remotePath: string
): string {
  const normalizedRemotePath = normalizeRemotePath(remotePath);

  return `${buildRemoteWorkspaceRoot(credentials)}${normalizedRemotePath}`;
}

function buildRemoteRelativePath(
  credentials: SshCredentials,
  remotePath: string
): string {
  const normalizedRemotePath = normalizeRemotePath(remotePath).replace(/^\/+/, "");

  return normalizeRelativePath(`ssh/${credentials.host}/${normalizedRemotePath}`);
}

function RemoteSshPanel({
  selectedPaths,
  onAddRemoteFile,
  onError,
  onToast,
  onLoading,
}: SshRemotePanelProps) {
  const [form, setForm] = useState<SshFormState>(DEFAULT_SSH_FORM);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [activeRemotePath, setActiveRemotePath] = useState("/");
  const [connectionLabel, setConnectionLabel] = useState<string | null>(null);
  type RemoteLoadingAction = "list" | "open" | "add-file" | "add-directory" | "download";
  const [directoryCopyProgress, setDirectoryCopyProgress] =
  useState<DirectoryCopyProgress | null>(null);
const [loadingEntryPath, setLoadingEntryPath] = useState<string | null>(null);
const [loadingAction, setLoadingAction] = useState<RemoteLoadingAction | null>(null);
  const [formCollapsed, setFormCollapsed] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [savedConnections, setSavedConnections] = useState<
    SshConnectionProfile[]
  >(() => parsePersistedSshConnections());

  useEffect(() => {
    localStorage.setItem(
      SSH_CONNECTION_STORAGE_KEY,
      JSON.stringify(savedConnections)
    );
  }, [savedConnections]);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  type LoadRemoteDirectoryOptions = {
    refreshSelectedFiles?: boolean;
  };
  
  async function refreshSelectedRemoteFiles(
    credentials: SshCredentials
  ): Promise<{
    refreshed: number;
    failed: number;
  }> {
    const workspaceRootPath = buildRemoteWorkspaceRoot(credentials);
    const workspacePrefix = `${workspaceRootPath}/`;
  
    const selectedRemotePaths = Array.from(selectedPaths)
      .filter((selectedPath) => selectedPath.startsWith(workspacePrefix))
      .map((selectedPath) =>
        normalizeRemotePath(selectedPath.slice(workspaceRootPath.length))
      );
  
    const uniqueRemotePaths = Array.from(new Set(selectedRemotePaths));
  
    if (uniqueRemotePaths.length === 0) {
      return {
        refreshed: 0,
        failed: 0,
      };
    }
  
    const refreshedResults = await Promise.all(
      uniqueRemotePaths.map(async (remotePath) => {
        try {
          const remoteFile = await invoke<RemoteFileContent>("ssh_read_file", {
            request: {
              credentials,
              remotePath,
            },
          });
  
          const name = getRemoteFileName(remoteFile.path);
  
          return {
            path: buildRemotePromptPath(credentials, remoteFile.path),
            relativePath: buildRemoteRelativePath(
              credentials,
              remoteFile.path
            ),
            name,
            extension: getFileExtensionFromName(name),
            size: remoteFile.size,
            content: remoteFile.content,
            charCount: remoteFile.content.length,
            addedAt: Date.now(),
          } satisfies SelectedPromptFile;
        } catch {
          return null;
        }
      })
    );
  
    const refreshedFiles = refreshedResults.filter(
      (file): file is SelectedPromptFile => file !== null
    );
  
    for (const refreshedFile of refreshedFiles) {
      onAddRemoteFile(refreshedFile, workspaceRootPath);
    }
  
    return {
      refreshed: refreshedFiles.length,
      failed: uniqueRemotePaths.length - refreshedFiles.length,
    };
  }

  function rememberCurrentConnection(remotePathOverride?: string) {
    const nextProfile = createSshConnectionProfile({
      ...form,
      remotePath: remotePathOverride ?? form.remotePath,
    });

    if (!nextProfile) {
      onError("Enter at least host and username before saving an SSH profile.");
      return null;
    }

    setSavedConnections((currentProfiles) =>
      upsertSshConnectionProfile(currentProfiles, nextProfile)
    );
    setSelectedProfileId(nextProfile.id);
    onError(null);

    return nextProfile;
  }

  function createOperationId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function manuallySaveCurrentConnection() {
    const savedProfile = rememberCurrentConnection();

    if (savedProfile) {
      onToast(
        `Saved ${savedProfile.label}. Passwords and passphrases are not stored.`
      );
    }
  }

  function loadSavedConnection(profileId: string) {
    setSelectedProfileId(profileId);

    if (!profileId) {
      setForm(DEFAULT_SSH_FORM);
      setConnectionLabel(null);
      setEntries([]);
      setActiveRemotePath("/");
      return;
    }

    const profile = savedConnections.find(
      (savedProfile) => savedProfile.id === profileId
    );

    if (!profile) return;

    setForm(applyProfileToSshForm(profile));
    setConnectionLabel(profile.label);
    setActiveRemotePath(normalizeRemotePath(profile.remotePath));
    setEntries([]);
    setFormCollapsed(false);
    onError(null);
    onToast(`Loaded ${profile.label}. Enter password to reconnect.`);
  }

  function forgetSavedConnection() {
    if (!selectedProfileId) return;

    const profile = savedConnections.find(
      (savedProfile) => savedProfile.id === selectedProfileId
    );

    setSavedConnections((currentProfiles) =>
      currentProfiles.filter(
        (savedProfile) => savedProfile.id !== selectedProfileId
      )
    );

    setSelectedProfileId("");
    onToast(profile ? `Removed ${profile.label}.` : "Removed SSH profile.");
  }

  async function choosePrivateKeyPath() {
    const selectedPath = await open({
      directory: false,
      multiple: false,
      title: "Select SSH private key",
    });

    if (typeof selectedPath !== "string") return;

    setForm((currentForm) => ({
      ...currentForm,
      privateKeyPath: selectedPath,
    }));
  }

  async function loadRemoteDirectory(
    pathOverride?: string,
    options: LoadRemoteDirectoryOptions = {}
  ) {
    onError(null);
    onToast(null);
  
    let credentials: SshCredentials;
    let remotePath: string;
  
    try {
      credentials = buildSshCredentials(form);
      remotePath = normalizeRemotePath(pathOverride ?? form.remotePath);
    } catch (error) {
      onError(getErrorMessage(error));
      return;
    }
  
    const hasPathOverride = typeof pathOverride === "string";
    const isReloading = options.refreshSelectedFiles === true;
  
    setLoadingEntryPath(
      hasPathOverride ? remotePath : "__remote_list__"
    );
    setLoadingAction(hasPathOverride ? "open" : "list");
  
    try {
      onLoading(
        `${
          isReloading ? "Reloading" : "Opening"
        } ${remotePath} from ${credentials.host}...`
      );
  
      const remoteEntries = await invoke<RemoteFileEntry[]>(
        "ssh_list_directory",
        {
          request: {
            credentials,
            remotePath,
          },
        }
      );
  
      setEntries(remoteEntries);
      setActiveRemotePath(remotePath);
  
      const nextConnectionLabel =
        `${credentials.username}@${credentials.host}:${
          credentials.port ?? 22
        }`;
  
      setConnectionLabel(nextConnectionLabel);
  
      setForm((currentForm) => ({
        ...currentForm,
        remotePath,
      }));
  
      rememberCurrentConnection(remotePath);
      setFormCollapsed(true);
  
      if (options.refreshSelectedFiles) {
        onLoading(
          `Refreshing selected files from ${credentials.host}...`
        );
  
        const refreshResult =
          await refreshSelectedRemoteFiles(credentials);
  
        const failedMessage =
          refreshResult.failed > 0
            ? ` ${refreshResult.failed.toLocaleString()} could not be refreshed.`
            : "";
  
        onToast(
          `Reloaded ${remoteEntries.length.toLocaleString()} remote entries and refreshed ${refreshResult.refreshed.toLocaleString()} selected files.${failedMessage}`
        );
  
        return;
      }
  
      onToast(
        `Loaded ${remoteEntries.length.toLocaleString()} remote entries.`
      );
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setLoadingEntryPath(null);
      setLoadingAction(null);
      onLoading(null);
    }
  }

  async function openRemoteDirectory(remotePath: string) {
    await loadRemoteDirectory(remotePath);
  }

  async function addRemoteFileToPrompt(entry: RemoteFileEntry) {
    onError(null);
    onToast(null);
    setLoadingEntryPath(entry.path);
    setLoadingAction("add-file");
  
    try {
      const credentials = buildSshCredentials(form);
  
      onLoading(`Adding ${entry.path} from ${credentials.host}...`);
  
      const remoteFile = await invoke<RemoteFileContent>("ssh_read_file", {
        request: {
          credentials,
          remotePath: entry.path,
        },
      });
  
      const name = entry.name || getRemoteFileName(entry.path);
      const promptPath = buildRemotePromptPath(credentials, entry.path);
      const relativePath = buildRemoteRelativePath(credentials, entry.path);
  
      const selectedFile: SelectedPromptFile = {
        path: promptPath,
        relativePath,
        name,
        extension: getFileExtensionFromName(name),
        size: remoteFile.size || entry.size,
        content: remoteFile.content,
        charCount: remoteFile.content.length,
        addedAt: Date.now(),
      };
  
      onAddRemoteFile(selectedFile, buildRemoteWorkspaceRoot(credentials));
      onToast(`Added remote file: ${relativePath}`);
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setLoadingEntryPath(null);
      setLoadingAction(null);
      onLoading(null);
    }
  }

  async function addRemoteDirectoryToPrompt(entry: RemoteFileEntry) {
    onError(null);
    onToast(null);
  
    const operationId = createOperationId("remote-directory-copy");
  
    let unlisten: UnlistenFn | null = null;
  
    setLoadingEntryPath(entry.path);
    setLoadingAction("add-directory");
  
    setDirectoryCopyProgress({
      operationId,
      phase: "scanning",
      completed: 0,
      total: 0,
      percent: 0,
      currentPath: entry.path,
    });
  
    try {
      const credentials = buildSshCredentials(form);
  
      unlisten = await listen<RemoteDirectoryProgressEvent>(
        "ssh-read-directory-progress",
        (event) => {
          const progress = event.payload;
  
          if (progress.operationId !== operationId) {
            return;
          }
  
          setDirectoryCopyProgress({
            operationId: progress.operationId,
            phase: progress.phase,
            completed: progress.completed,
            total: progress.total,
            percent: progress.percent,
            currentPath: progress.currentPath,
          });
  
          if (progress.phase === "scanning") {
            onLoading(`Scanning ${entry.path} on ${credentials.host}...`);
            return;
          }
  
          if (progress.phase === "reading") {
            onLoading(
              `Copying ${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} files (${progress.percent}%)...`
            );
            return;
          }
  
          onLoading(`Finishing ${entry.path}...`);
        }
      );
  
      onLoading(`Scanning ${entry.path} on ${credentials.host}...`);
  
      const remoteFiles = await invoke<RemoteDirectoryFileContent[]>(
        "ssh_read_directory_files",
        {
          request: {
            credentials,
            remotePath: entry.path,
            operationId,
          },
        }
      );
  
      if (remoteFiles.length === 0) {
        onToast(`No supported files found in ${entry.path}.`);
        return;
      }
  
      const workspaceRootPath = buildRemoteWorkspaceRoot(credentials);
  
      for (const remoteFile of remoteFiles) {
        const name = getRemoteFileName(remoteFile.path);
  
        const selectedFile: SelectedPromptFile = {
          path: buildRemotePromptPath(credentials, remoteFile.path),
          relativePath: buildRemoteRelativePath(credentials, remoteFile.path),
          name,
          extension: getFileExtensionFromName(name),
          size: remoteFile.size,
          content: remoteFile.content,
          charCount: remoteFile.content.length,
          addedAt: Date.now(),
        };
  
        onAddRemoteFile(selectedFile, workspaceRootPath);
      }
  
      setDirectoryCopyProgress((currentProgress) =>
        currentProgress?.operationId === operationId
          ? {
              ...currentProgress,
              phase: "done",
              completed: remoteFiles.length,
              total: remoteFiles.length,
              percent: 100,
            }
          : currentProgress
      );
  
      onToast(
        `Added ${remoteFiles.length.toLocaleString()} files from ${entry.path}.`
      );
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      if (unlisten) {
        unlisten();
      }
  
      setLoadingEntryPath(null);
      setLoadingAction(null);
      onLoading(null);
  
      window.setTimeout(() => {
        setDirectoryCopyProgress((currentProgress) =>
          currentProgress?.operationId === operationId ? null : currentProgress
        );
      }, 900);
    }
  }
  async function downloadRemoteFile(entry: RemoteFileEntry) {
  onError(null);
  onToast(null);
  setLoadingEntryPath(entry.path);
  setLoadingAction("download");

  try {
    const credentials = buildSshCredentials(form);
    const defaultPath = entry.name || getRemoteFileName(entry.path);

    const localPath = await save({
      title: `Save ${defaultPath}`,
      defaultPath,
    });

    if (!localPath) return;

    onLoading(`Copying ${entry.path} from ${credentials.host}...`);

    await invoke<void>("ssh_download_file", {
      request: {
        credentials,
        remotePath: entry.path,
        localPath,
      },
    });

    onToast(`Downloaded ${entry.name} to ${localPath}.`);
  } catch (error) {
    onError(getErrorMessage(error));
  } finally {
    setLoadingEntryPath(null);
    setLoadingAction(null);
    onLoading(null);
  }
}

  return (
    <section className="ssh-panel">
      <div className="ssh-panel-title">
        <div>
          <span>SSH Remote</span>
          {connectionLabel && <strong>{connectionLabel}</strong>}
        </div>

        <button
          type="button"
          className="ghost-button compact-button"
          onClick={() => setFormCollapsed((currentValue) => !currentValue)}
        >
          {formCollapsed ? "Show login" : "Hide login"}
        </button>
      </div>

      {formCollapsed && (
  <div className="ssh-collapsed-summary">
    <span
      title={
        connectionLabel
          ? `${connectionLabel} · ${activeRemotePath}`
          : "SSH login hidden"
      }
    >
      {connectionLabel
        ? `${connectionLabel} · ${activeRemotePath}`
        : "SSH login hidden"}
    </span>

    <div className="ssh-collapsed-actions">
      <button
        type="button"
        disabled={
          activeRemotePath === "/" ||
          Boolean(loadingEntryPath)
        }
        onClick={() =>
          void openRemoteDirectory(
            getRemoteParentPath(activeRemotePath)
          )
        }
        title="Open the parent directory"
      >
        ↑ Up one
      </button>

      <button
        type="button"
        disabled={
          !connectionLabel ||
          Boolean(loadingEntryPath)
        }
        onClick={() =>
          void loadRemoteDirectory(activeRemotePath, {
            refreshSelectedFiles: true,
          })
        }
        title="Reload the directory and refresh selected files"
      >
        {loadingEntryPath === activeRemotePath
          ? "Reloading..."
          : "Reload"}
      </button>

      <button
        type="button"
        disabled={Boolean(loadingEntryPath)}
        onClick={() => setFormCollapsed(false)}
      >
        Change / password
      </button>
    </div>
  </div>
)}

      {!formCollapsed && (
        <div className="ssh-form">
          <div className="ssh-profile-row">
            <label>
              <span>Saved connections</span>
              <select
                value={selectedProfileId}
                onChange={(event) => loadSavedConnection(event.target.value)}
              >
                <option value="">New connection</option>
                {savedConnections.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              disabled={!form.host.trim() || !form.username.trim()}
              onClick={manuallySaveCurrentConnection}
            >
              Save
            </button>

            <button
              type="button"
              disabled={!selectedProfileId}
              onClick={forgetSavedConnection}
            >
              Forget
            </button>
          </div>

          <div className="ssh-grid">
            <label>
              <span>Host</span>
              <input
                value={form.host}
                placeholder="example.com"
                autoComplete="off"
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    host: event.target.value,
                  }))
                }
              />
            </label>

            <label>
              <span>Port</span>
              <input
                value={form.port}
                inputMode="numeric"
                placeholder="22"
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    port: event.target.value,
                  }))
                }
              />
            </label>

            <label>
              <span>Username</span>
              <input
                value={form.username}
                placeholder="root"
                autoComplete="username"
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    username: event.target.value,
                  }))
                }
              />
            </label>

            <label>
              <span>Auth</span>
              <select
                value={form.authMode}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    authMode: event.target.value as SshAuthMode,
                  }))
                }
              >
                <option value="password">Password</option>
                <option value="privateKey">Private key</option>
              </select>
            </label>
          </div>

          {form.authMode === "password" ? (
            <label>
              <span>Password</span>
              <input
                value={form.password}
                type="password"
                autoComplete="current-password"
                placeholder="Required each reconnect"
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    password: event.target.value,
                  }))
                }
              />
            </label>
          ) : (
            <div className="ssh-key-row">
              <label>
                <span>Private key path</span>
                <input
                  value={form.privateKeyPath}
                  placeholder="/Users/me/.ssh/id_ed25519"
                  onChange={(event) =>
                    setForm((currentForm) => ({
                      ...currentForm,
                      privateKeyPath: event.target.value,
                    }))
                  }
                />
              </label>

              <button type="button" onClick={() => void choosePrivateKeyPath()}>
                Browse
              </button>

              <label>
                <span>Passphrase</span>
                <input
                  value={form.passphrase}
                  type="password"
                  placeholder="Required each reconnect if key is encrypted"
                  onChange={(event) =>
                    setForm((currentForm) => ({
                      ...currentForm,
                      passphrase: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          )}

          <div className="ssh-path-row">
          <button
            type="button"
            onClick={() =>
              void openRemoteDirectory(
                getRemoteParentPath(activeRemotePath)
              )
            }
            disabled={
              activeRemotePath === "/" ||
              Boolean(loadingEntryPath)
            }
          >
            ↑ Up one
          </button>

            <input
              value={form.remotePath}
              placeholder="/var/www"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void loadRemoteDirectory();
                }
              }}
              onChange={(event) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  remotePath: event.target.value,
                }))
              }
            />

            <button
              type="button"
              className="primary-button"
              disabled={Boolean(loadingEntryPath)}
              onClick={() => void loadRemoteDirectory()}
            >
              Connect / List
            </button>
          </div>
        </div>
      )}

      <div className="ssh-entries">
        {sortedEntries.length === 0 && (
          <div className="empty-state">
            Select a saved SSH connection or enter credentials, then list a
            remote directory.
          </div>
        )}

{sortedEntries.map((entry) => {
  const credentialsPreview =
    form.host.trim() && form.username.trim()
      ? {
          host: form.host.trim(),
          username: form.username.trim(),
          port: Number(form.port || "22"),
        }
      : null;

  const promptPath = credentialsPreview
    ? buildRemotePromptPath(credentialsPreview, entry.path)
    : entry.path;

  const isSelected = selectedPaths.has(promptPath);
  const isLoading = loadingEntryPath === entry.path;
  const isBusy = Boolean(loadingEntryPath);
  const activeDirectoryProgress =
  entry.isDirectory &&
  loadingEntryPath === entry.path &&
  loadingAction === "add-directory"
    ? directoryCopyProgress
    : null;

    const entrySizeLabel = entry.isDirectory
    ? activeDirectoryProgress
      ? activeDirectoryProgress.phase === "scanning"
        ? "Scanning..."
        : `${activeDirectoryProgress.percent}%`
      : isLoading && loadingAction === "open"
        ? "Opening..."
        : "folder"
    : isLoading && loadingAction === "add-file"
      ? "Adding..."
      : isLoading && loadingAction === "download"
        ? "Copying..."
        : formatBytes(entry.size);

  return (
    <div
      key={entry.path}
      className={`ssh-entry ${isSelected ? "selected" : ""}`}
      title={entry.path}
    >
      <button
        type="button"
        className="ssh-entry-main"
        disabled={isBusy}
        onClick={() =>
          entry.isDirectory
            ? void openRemoteDirectory(entry.path)
            : void addRemoteFileToPrompt(entry)
        }
      >
        <span className="ssh-entry-icon">
          {entry.isDirectory ? "▸" : "•"}
        </span>

        <span className="ssh-entry-name">
          {entry.name || getRemoteFileName(entry.path)}
        </span>

        <span className="ssh-entry-size">{entrySizeLabel}</span>
      </button>

      <div className="ssh-entry-actions">
        {entry.isDirectory ? (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void addRemoteDirectoryToPrompt(entry)}
          >
            {activeDirectoryProgress
              ? activeDirectoryProgress.phase === "scanning"
                ? "Scanning..."
                : `${activeDirectoryProgress.percent}%`
              : "+ all"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void addRemoteFileToPrompt(entry)}
            >
              {isLoading && loadingAction === "add-file"
                ? "Adding..."
                : isSelected
                  ? "Refresh"
                  : "+ prompt"}
            </button>

            <button
              type="button"
              disabled={isBusy}
              onClick={() => void downloadRemoteFile(entry)}
            >
              {isLoading && loadingAction === "download"
                ? "Copying..."
                : "Download"}
            </button>
          </>
        )}
      </div>

      {activeDirectoryProgress ? (
        <div className="ssh-entry-progress">
          <div className="ssh-entry-progress-track">
            <div
              className="ssh-entry-progress-fill"
              style={{ width: `${activeDirectoryProgress.percent}%` }}
            />
          </div>

          <span className="ssh-entry-progress-label">
            {activeDirectoryProgress.phase === "scanning"
              ? "Scanning remote directory..."
              : `${activeDirectoryProgress.percent}% · ${activeDirectoryProgress.completed.toLocaleString()} / ${activeDirectoryProgress.total.toLocaleString()} files`}
          </span>
        </div>
      ) : null}
    </div>
  );
})}
      </div>
    </section>
  );
}

export default function App() {
  const [copyingOutput, setCopyingOutput] = useState(false);
  const [explorerView, setExplorerView] = useState<ExplorerView>("local");
  const [loadingFolderPath, setLoadingFolderPath] = useState<string | null>(null);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [projectTabs, setProjectTabs] = useState<ProjectTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [explorerControlsCollapsed, setExplorerControlsCollapsed] =
  useState(false);
  const handledInitialOpenPrompt = useRef(false);
  const autoReloadedProjectIds = useRef(new Set<string>());

  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraph | null>(
    null
  );
  const [loadingLinkedFilePath, setLoadingLinkedFilePath] = useState<
    string | null
  >(null);

  const activeProject = useMemo(() => {
    return (
      projectTabs.find((project) => project.id === activeProjectId) ??
      projectTabs[0] ??
      null
    );
  }, [activeProjectId, projectTabs]);

  const files = activeProject?.files ?? [];
  const selectedFiles = activeProject?.selectedFiles ?? [];
  const query = activeProject?.query ?? "";
  const personalPrompt = activeProject?.personalPrompt ?? "";
  const rootPath = activeProject?.rootPath ?? null;
  const isRemoteWorkspace = rootPath ? isRemoteRootPath(rootPath) : false;

  const promptOutput = useMemo(
    () => buildPromptOutput(personalPrompt, selectedFiles),
    [personalPrompt, selectedFiles]
  );

  const outputCharacterCount = promptOutput.length;

  const activeFile = useMemo(() => {
    return (
      selectedFiles.find((file) => file.path === activeProject?.activePath) ??
      selectedFiles[selectedFiles.length - 1] ??
      null
    );
  }, [activeProject?.activePath, selectedFiles]);

  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) return files;

    return files.filter((file) =>
      normalizeRelativePath(file.relativePath)
        .toLowerCase()
        .includes(normalizedQuery)
    );
  }, [files, query]);

  const fileTree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const selectedPaths = useMemo(() => {
    return new Set(selectedFiles.map((file) => file.path));
  }, [selectedFiles]);

  const expandedDirectoryPathSet = useMemo(() => {
    return new Set(activeProject?.expandedDirectoryPaths ?? []);
  }, [activeProject?.expandedDirectoryPaths]);

  const updateProject = useCallback(
    (projectId: string, updater: (project: ProjectTab) => ProjectTab) => {
      setProjectTabs((currentProjects) =>
        currentProjects.map((project) =>
          project.id === projectId ? updater(project) : project
        )
      );
    },
    []
  );

  const updateActiveProject = useCallback(
    (updater: (project: ProjectTab) => ProjectTab) => {
      if (!activeProject) return;
      updateProject(activeProject.id, updater);
    },
    [activeProject, updateProject]
  );

  const reloadProject = useCallback(
    async (projectId: string) => {
      const targetProject = projectTabs.find(
        (project) => project.id === projectId
      );

      if (!targetProject) return;

      if (isRemoteRootPath(targetProject.rootPath)) {
        setToastMessage("Remote SSH workspaces are refreshed from the Remote explorer.");
        return;
      }

      setErrorMessage(null);
      setToastMessage(null);
      setLoadingMessage(`Reloading ${targetProject.name}...`);

      try {
        const scannedFiles = await scanDirectory(targetProject.rootPath);

        const selectedPathOrder =
          targetProject.selectedFiles.length > 0
            ? targetProject.selectedFiles.map((file) => file.path)
            : targetProject.pendingSelectedPaths;

        const refreshedSelectedFiles = await readSelectedFilesFromDisk(
          targetProject.rootPath,
          scannedFiles,
          selectedPathOrder
        );

        updateProject(projectId, (project) => {
          const nextActivePath = refreshedSelectedFiles.some(
            (file) => file.path === project.activePath
          )
            ? project.activePath
            : refreshedSelectedFiles[refreshedSelectedFiles.length - 1]?.path ??
              null;

          return {
            ...project,
            files: scannedFiles,
            selectedFiles: refreshedSelectedFiles,
            pendingSelectedPaths: [],
            activePath: nextActivePath,
            lastScannedAt: Date.now(),
          };
        });

        setToastMessage(
          `Reloaded ${scannedFiles.length.toLocaleString()} files from ${
            targetProject.name
          }.`
        );
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      } finally {
        setLoadingMessage(null);
      }
    },
    [projectTabs, updateProject]
  );

  const openWorkspace = useCallback(async () => {
    setErrorMessage(null);
    setToastMessage(null);

    const selectedDirectory = await open({
      directory: true,
      multiple: false,
      title: "Open project directory",
    });

    if (typeof selectedDirectory !== "string") {
      return;
    }

    const normalizedSelectedDirectory = normalizeRootPath(selectedDirectory);

    const existingProject = projectTabs.find(
      (project) =>
        normalizeRootPath(project.rootPath) === normalizedSelectedDirectory
    );

    if (existingProject) {
      setExplorerView("local");
      setActiveProjectId(existingProject.id);
      await reloadProject(existingProject.id);
      return;
    }

    try {
      setExplorerView("local");
      setLoadingMessage("Scanning project files...");

      const scannedFiles = await scanDirectory(selectedDirectory);
      const nextProject = createProjectTab(selectedDirectory, scannedFiles);

      setProjectTabs((currentProjects) => [...currentProjects, nextProject]);
      setActiveProjectId(nextProject.id);
      setToastMessage(`Loaded ${scannedFiles.length.toLocaleString()} files.`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setLoadingMessage(null);
    }
  }, [projectTabs, reloadProject]);

  useEffect(() => {
    const persistedState = parsePersistedProjectState();

    setProjectTabs(persistedState.tabs.map(toRuntimeProjectTab));
    setActiveProjectId(persistedState.activeProjectId);
    setStorageHydrated(true);
  }, []);

  useEffect(() => {
    setDependencyGraph(null);
  }, [activeProject?.id, activeProject?.rootPath]);

  useEffect(() => {
    if (!storageHydrated) return;

    const persistedState = toPersistedProjectState(
      projectTabs,
      activeProjectId
    );

    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(persistedState));
  }, [activeProjectId, projectTabs, storageHydrated]);

  useEffect(() => {
    if (!storageHydrated || handledInitialOpenPrompt.current) return;

    handledInitialOpenPrompt.current = true;

    if (projectTabs.length === 0) {
      void openWorkspace();
    }
  }, [openWorkspace, projectTabs.length, storageHydrated]);

  useEffect(() => {
    if (!storageHydrated || !activeProject) return;
    if (isRemoteRootPath(activeProject.rootPath)) return;
    if (activeProject.lastScannedAt !== null) return;
    if (autoReloadedProjectIds.current.has(activeProject.id)) return;

    autoReloadedProjectIds.current.add(activeProject.id);
    void reloadProject(activeProject.id);
  }, [activeProject, reloadProject, storageHydrated]);

  const reloadActiveProject = useCallback(async () => {
    if (!activeProject) {
      setErrorMessage("Open a project directory first.");
      return;
    }

    if (isRemoteRootPath(activeProject.rootPath)) {
      setToastMessage("Use the Remote explorer to refresh SSH folders.");
      return;
    }

    await reloadProject(activeProject.id);
  }, [activeProject, reloadProject]);

  const closeProjectTab = useCallback(
    (projectId: string) => {
      const projectIndex = projectTabs.findIndex(
        (project) => project.id === projectId
      );

      if (projectIndex < 0) return;

      const nextProjects = projectTabs.filter(
        (project) => project.id !== projectId
      );

      setProjectTabs(nextProjects);

      if (activeProjectId === projectId) {
        const nextActiveProject =
          nextProjects[Math.min(projectIndex, nextProjects.length - 1)] ?? null;

        setActiveProjectId(nextActiveProject?.id ?? null);
      }

      setErrorMessage(null);
      setToastMessage("Project tab closed.");
    },
    [activeProjectId, projectTabs]
  );

  const addRemoteFileToPrompt = useCallback(
    (file: SelectedPromptFile, workspaceRootPath: string) => {
      setExplorerView("remote");

      const normalizedWorkspaceRootPath = normalizeRootPath(workspaceRootPath);

      const targetProject =
        projectTabs.find(
          (project) =>
            normalizeRootPath(project.rootPath) === normalizedWorkspaceRootPath
        ) ?? null;

      if (!targetProject) {
        const nextProject: ProjectTab = {
          ...createProjectTab(workspaceRootPath, []),
          selectedFiles: [file],
          activePath: file.path,
          pendingSelectedPaths: [],
          lastScannedAt: Date.now(),
        };

        setProjectTabs((currentProjects) => [...currentProjects, nextProject]);
        setActiveProjectId(nextProject.id);
        return;
      }

      updateProject(targetProject.id, (project) => {
        const alreadySelected = project.selectedFiles.some(
          (selectedFile) => selectedFile.path === file.path
        );

        const nextSelectedFiles = alreadySelected
          ? project.selectedFiles.map((selectedFile) =>
              selectedFile.path === file.path ? file : selectedFile
            )
          : [...project.selectedFiles, file];

        return {
          ...project,
          selectedFiles: nextSelectedFiles,
          pendingSelectedPaths: [],
          activePath: file.path,
        };
      });

      setActiveProjectId(targetProject.id);
    },
    [projectTabs, updateProject]
  );

  const toggleDirectory = useCallback(
    (path: string) => {
      updateActiveProject((project) => {
        const nextPaths = new Set(project.expandedDirectoryPaths);

        if (nextPaths.has(path)) {
          nextPaths.delete(path);
        } else {
          nextPaths.add(path);
        }

        return {
          ...project,
          expandedDirectoryPaths: Array.from(nextPaths),
        };
      });
    },
    [updateActiveProject]
  );

  const addDirectoryToPrompt = useCallback(
    async (directory: DirectoryTreeNode) => {
      if (!activeProject) {
        setErrorMessage("Open a directory first.");
        return;
      }

      if (isRemoteRootPath(activeProject.rootPath)) {
        setErrorMessage("Use the Remote explorer to add SSH files.");
        return;
      }

      setErrorMessage(null);
      setToastMessage(null);
      setLoadingFolderPath(directory.path);
      setLoadingMessage(`Adding files from ${directory.path}...`);

      try {
        const directoryFiles = getFilesInDirectory(
          activeProject.files,
          directory.path
        );

        if (directoryFiles.length === 0) {
          setToastMessage(`No supported files found in ${directory.path}.`);
          return;
        }

        const existingSelectedPaths = new Set(
          activeProject.selectedFiles.map((file) => file.path)
        );

        const pathsToAdd = directoryFiles
          .map((file) => file.path)
          .filter((path) => !existingSelectedPaths.has(path));

        if (pathsToAdd.length === 0) {
          setToastMessage(
            `All ${directoryFiles.length.toLocaleString()} files from ${
              directory.path
            } are already selected.`
          );
          return;
        }

        const loadedFiles = await readSelectedFilesFromDisk(
          activeProject.rootPath,
          activeProject.files,
          pathsToAdd
        );

        if (loadedFiles.length === 0) {
          setErrorMessage(`Could not read any files from ${directory.path}.`);
          return;
        }

        updateProject(activeProject.id, (project) => {
          const nextSelectedFilePaths = new Set(
            project.selectedFiles.map((file) => file.path)
          );

          const nextSelectedFiles = [...project.selectedFiles];

          for (const loadedFile of loadedFiles) {
            if (nextSelectedFilePaths.has(loadedFile.path)) continue;

            nextSelectedFiles.push(loadedFile);
            nextSelectedFilePaths.add(loadedFile.path);
          }

          return {
            ...project,
            selectedFiles: nextSelectedFiles,
            pendingSelectedPaths: [],
            activePath:
              loadedFiles[loadedFiles.length - 1]?.path ?? project.activePath,
          };
        });

        setToastMessage(
          `Added ${loadedFiles.length.toLocaleString()} files from ${
            directory.path
          }.`
        );
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      } finally {
        setLoadingFolderPath(null);
        setLoadingMessage(null);
      }
    },
    [activeProject, updateProject]
  );

  const ensureDependencyGraph = useCallback(async () => {
    if (!activeProject) {
      throw new Error("Open a directory first.");
    }

    if (isRemoteRootPath(activeProject.rootPath)) {
      throw new Error("Linked-file analysis is only available for local projects.");
    }

    if (dependencyGraph) {
      return dependencyGraph;
    }

    setLoadingMessage("Analyzing linked files...");

    const allFilePaths = activeProject.files.map((file) => file.path);

    const loadedFiles = await readSelectedFilesFromDisk(
      activeProject.rootPath,
      activeProject.files,
      allFilePaths
    );

    const graph = buildDependencyGraph(loadedFiles as LoadedCodeFile[]);

    setDependencyGraph(graph);

    return graph;
  }, [activeProject, dependencyGraph]);

  const addLinkedFilesToPrompt = useCallback(
    async (sourceFile: CodeFileEntry) => {
      if (!activeProject) {
        setErrorMessage("Open a directory first.");
        return;
      }

      if (isRemoteRootPath(activeProject.rootPath)) {
        setErrorMessage("Linked-file analysis is only available for local projects.");
        return;
      }

      setErrorMessage(null);
      setToastMessage(null);
      setLoadingLinkedFilePath(sourceFile.path);
      setLoadingMessage(`Finding linked files for ${sourceFile.relativePath}...`);

      try {
        const graph = await ensureDependencyGraph();

        const linkedRelativePaths = getDirectLinkedRelativePaths(
          graph,
          sourceFile.relativePath
        );

        if (linkedRelativePaths.length === 0) {
          setToastMessage(`No directly linked files found for ${sourceFile.name}.`);
          return;
        }

        const fileByRelativePath = new Map(
          activeProject.files.map((file) => [
            normalizeRelativePath(file.relativePath),
            file,
          ])
        );

        const selectedPathSet = new Set(
          activeProject.selectedFiles.map((file) => file.path)
        );

        const linkedFilesToAdd = linkedRelativePaths
          .map((relativePath) => fileByRelativePath.get(relativePath))
          .filter((file): file is CodeFileEntry => Boolean(file))
          .filter((file) => !selectedPathSet.has(file.path));

        if (linkedFilesToAdd.length === 0) {
          setToastMessage(
            `All ${linkedRelativePaths.length.toLocaleString()} linked files are already selected.`
          );
          return;
        }

        const loadedLinkedFiles = await readSelectedFilesFromDisk(
          activeProject.rootPath,
          activeProject.files,
          linkedFilesToAdd.map((file) => file.path)
        );

        if (loadedLinkedFiles.length === 0) {
          setErrorMessage("Could not read any linked files.");
          return;
        }

        updateProject(activeProject.id, (project) => {
          const nextSelectedPathSet = new Set(
            project.selectedFiles.map((file) => file.path)
          );

          const nextSelectedFiles = [...project.selectedFiles];

          for (const loadedFile of loadedLinkedFiles) {
            if (nextSelectedPathSet.has(loadedFile.path)) continue;

            nextSelectedFiles.push(loadedFile);
            nextSelectedPathSet.add(loadedFile.path);
          }

          return {
            ...project,
            selectedFiles: nextSelectedFiles,
            pendingSelectedPaths: [],
            activePath:
              loadedLinkedFiles[loadedLinkedFiles.length - 1]?.path ??
              project.activePath,
          };
        });

        setToastMessage(
          `Added ${loadedLinkedFiles.length.toLocaleString()} linked files.`
        );
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      } finally {
        setLoadingLinkedFilePath(null);
        setLoadingMessage(null);
      }
    },
    [activeProject, ensureDependencyGraph, updateProject]
  );

  const addFileToPrompt = useCallback(
    async (file: CodeFileEntry) => {
      if (!activeProject) {
        setErrorMessage("Open a directory first.");
        return;
      }

      if (isRemoteRootPath(activeProject.rootPath)) {
        setErrorMessage("Use the Remote explorer to add SSH files.");
        return;
      }

      setErrorMessage(null);
      setToastMessage(null);
      setLoadingFilePath(file.path);

      try {
        const content = await invoke<string>("read_code_file", {
          rootPath: activeProject.rootPath,
          filePath: file.path,
        });

        const nextSelectedFile: SelectedPromptFile = {
          ...file,
          relativePath: normalizeRelativePath(file.relativePath),
          content,
          charCount: content.length,
          addedAt: Date.now(),
        };

        updateProject(activeProject.id, (project) => {
          const alreadySelected = project.selectedFiles.some(
            (selectedFile) => selectedFile.path === file.path
          );

          const nextSelectedFiles = alreadySelected
            ? project.selectedFiles.map((selectedFile) =>
                selectedFile.path === file.path ? nextSelectedFile : selectedFile
              )
            : [...project.selectedFiles, nextSelectedFile];

          return {
            ...project,
            selectedFiles: nextSelectedFiles,
            pendingSelectedPaths: [],
            activePath: file.path,
          };
        });
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      } finally {
        setLoadingFilePath(null);
      }
    },
    [activeProject, updateProject]
  );

  const removeSelectedFile = useCallback(
    (path: string) => {
      updateActiveProject((project) => {
        const nextSelectedFiles = project.selectedFiles.filter(
          (file) => file.path !== path
        );

        return {
          ...project,
          selectedFiles: nextSelectedFiles,
          pendingSelectedPaths: [],
          activePath:
            project.activePath === path
              ? nextSelectedFiles[nextSelectedFiles.length - 1]?.path ?? null
              : project.activePath,
        };
      });
    },
    [updateActiveProject]
  );

  const moveSelectedFile = useCallback(
    (path: string, direction: -1 | 1) => {
      updateActiveProject((project) => {
        const currentIndex = project.selectedFiles.findIndex(
          (file) => file.path === path
        );
        const nextIndex = currentIndex + direction;

        if (
          currentIndex < 0 ||
          nextIndex < 0 ||
          nextIndex >= project.selectedFiles.length
        ) {
          return project;
        }

        const nextSelectedFiles = [...project.selectedFiles];
        const [movedFile] = nextSelectedFiles.splice(currentIndex, 1);
        nextSelectedFiles.splice(nextIndex, 0, movedFile);

        return {
          ...project,
          selectedFiles: nextSelectedFiles,
          pendingSelectedPaths: [],
        };
      });
    },
    [updateActiveProject]
  );

  const startOver = useCallback(() => {
    updateActiveProject((project) => ({
      ...project,
      selectedFiles: [],
      pendingSelectedPaths: [],
      activePath: null,
      personalPrompt: "",
    }));

    setErrorMessage(null);
    setToastMessage("Prompt stack reset.");
  }, [updateActiveProject]);

  const copyOutputToClipboard = useCallback(async () => {
    if (!promptOutput.trim()) {
      setErrorMessage("Select at least one file or enter a personal prompt.");
      return;
    }
  
    setCopyingOutput(true);
    setLoadingMessage("Copying output to clipboard...");
  
    try {
      await writeText(promptOutput);
      setToastMessage(
        `Copied ${outputCharacterCount.toLocaleString()} characters to clipboard.`
      );
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setCopyingOutput(false);
      setLoadingMessage(null);
    }
  }, [outputCharacterCount, promptOutput]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <section className="brand">
          <div className="brand-mark">P</div>

          <div>
            <h1>PromptPAD</h1>
            <p>by ArchivesPRO</p>
          </div>
        </section>

        <section className="topbar-actions">
          <button type="button" onClick={() => void openWorkspace()}>
            Open Directory
          </button>

          <button
            type="button"
            disabled={!activeProject || Boolean(loadingMessage) || isRemoteWorkspace}
            onClick={() => void reloadActiveProject()}
          >
            Reload Directory
          </button>

          <button
            type="button"
            disabled={!activeProject || !promptOutput.trim()}
            onClick={startOver}
          >
            Start Over
          </button>

          <button
            type="button"
            className="primary-button"
            disabled={!promptOutput.trim() || copyingOutput}
            onClick={() => void copyOutputToClipboard()}
          >
            {copyingOutput ? "Copying..." : "Copy Output"}
          </button>
        </section>
      </header>

      <section className="project-tabs">
        {projectTabs.map((project) => (
          <div
            key={project.id}
            className={`project-tab ${
              activeProject?.id === project.id ? "active" : ""
            }`}
          >
            <button
              type="button"
              className="project-tab-main"
              onClick={() => setActiveProjectId(project.id)}
              title={project.rootPath}
            >
              <span>{project.name}</span>
            </button>

            <button
              type="button"
              className="project-tab-close"
              onClick={() => closeProjectTab(project.id)}
              aria-label={`Close ${project.name}`}
              title="Close project"
            >
              ×
            </button>
          </div>
        ))}

        <button
          type="button"
          className="project-tab-add"
          onClick={() => void openWorkspace()}
        >
          + Open Project
        </button>
      </section>

      <section className="workspace-meta">
        <span title={rootPath ?? "No directory selected"}>
          {rootPath ?? "No directory selected"}
        </span>

        <strong>{files.length.toLocaleString()} files</strong>
        <strong>{selectedFiles.length.toLocaleString()} selected</strong>
        <strong>{outputCharacterCount.toLocaleString()} characters</strong>
        <strong>{formatLastScannedAt(activeProject?.lastScannedAt ?? null)}</strong>
      </section>

      {(loadingMessage || errorMessage || toastMessage) && (
        <section className="message-row">
          {loadingMessage && <div className="message info">{loadingMessage}</div>}
          {toastMessage && <div className="message success">{toastMessage}</div>}
          {errorMessage && <div className="message error">{errorMessage}</div>}
        </section>
      )}

      <section className="main-grid">
      <aside
  className={`file-browser ${
    explorerControlsCollapsed ? "controls-collapsed" : ""
  }`}
>
  <div className="panel-header split explorer-header">
    <div>
      <h2>Explorer</h2>
      <p>
        {explorerView === "local"
          ? "Local project tree."
          : "Remote SSH browser."}
      </p>
    </div>

    <button
      type="button"
      className="ghost-button compact-button"
      onClick={() =>
        setExplorerControlsCollapsed((currentValue) => !currentValue)
      }
    >
      {explorerControlsCollapsed ? "Show controls" : "Hide controls"}
    </button>
  </div>

  {explorerControlsCollapsed ? (
    <div className="explorer-compact-switch">
      <strong>{explorerView === "local" ? "Local" : "Remote"}</strong>

      <button
        type="button"
        onClick={() =>
          setExplorerView((currentView) =>
            currentView === "local" ? "remote" : "local"
          )
        }
      >
        Switch to {explorerView === "local" ? "Remote" : "Local"}
      </button>
    </div>
  ) : (
    <div
      className="explorer-view-switch"
      role="tablist"
      aria-label="Explorer source"
    >
      <button
        type="button"
        role="tab"
        aria-selected={explorerView === "local"}
        className={explorerView === "local" ? "active" : ""}
        onClick={() => setExplorerView("local")}
      >
        Local
      </button>

      <button
        type="button"
        role="tab"
        aria-selected={explorerView === "remote"}
        className={explorerView === "remote" ? "active" : ""}
        onClick={() => setExplorerView("remote")}
      >
        Remote
      </button>
    </div>
  )}

  {explorerView === "local" && (
    <div className="explorer-source-view local-source-view">
      {!explorerControlsCollapsed && (
        <input
          className="search-input"
          value={query}
          disabled={!activeProject || isRemoteWorkspace}
          onChange={(event) =>
            updateActiveProject((project) => ({
              ...project,
              query: event.target.value,
            }))
          }
          placeholder="Search files..."
        />
      )}

      <div className="tree-list">
        {fileTree.length === 0 && (
          <div className="empty-state">
            {activeProject
              ? isRemoteWorkspace
                ? "This is a remote SSH tab. Switch to Remote to browse server files."
                : "No files loaded. Reload the directory."
              : "Open a local project directory to begin."}
          </div>
        )}

        {!isRemoteWorkspace && (
          <FileTree
            nodes={fileTree}
            selectedPaths={selectedPaths}
            expandedDirectoryPaths={expandedDirectoryPathSet}
            searchActive={query.trim().length > 0}
            loadingFilePath={loadingFilePath}
            loadingFolderPath={loadingFolderPath}
            loadingLinkedFilePath={loadingLinkedFilePath}
            onToggleDirectory={toggleDirectory}
            onSelectDirectory={(directory) => void addDirectoryToPrompt(directory)}
            onSelectFile={(file) => void addFileToPrompt(file)}
            onSelectLinkedFiles={(file) => void addLinkedFilesToPrompt(file)}
          />
        )}
      </div>
    </div>
  )}

  {explorerView === "remote" && (
    <div className="explorer-source-view remote-source-view">
      <RemoteSshPanel
        selectedPaths={selectedPaths}
        onAddRemoteFile={addRemoteFileToPrompt}
        onError={setErrorMessage}
        onToast={setToastMessage}
        onLoading={setLoadingMessage}
      />
    </div>
  )}
</aside>

        <section
  className={`prompt-builder ${
    explorerView === "remote" ? "remote-view" : ""
  }`}
>
          <section className="personal-prompt-card">
            <div className="panel-header">
              <div>
                <h2>Personal Prompt</h2>
                <p>This text is included at the top of the copied output.</p>
              </div>
            </div>

            <textarea
              className="personal-prompt-input"
              value={personalPrompt}
              disabled={!activeProject}
              onChange={(event) =>
                updateActiveProject((project) => ({
                  ...project,
                  personalPrompt: event.target.value,
                }))
              }
              spellCheck={false}
              placeholder="Enter your own instructions, context, requirements, or task here..."
            />
          </section>

          <section className="selected-card">
            <div className="panel-header split">
              <div>
                <h2>Selected Tabs</h2>
                <p>Order here controls the final copied output.</p>
              </div>

              <button
                type="button"
                disabled={!activeProject || !promptOutput.trim()}
                onClick={startOver}
              >
                Start Over
              </button>
            </div>

            <div className="selected-tabs">
              {selectedFiles.length === 0 && (
                <div className="empty-state">
                  No files selected yet. Click files in the explorer.
                </div>
              )}

              {selectedFiles.map((file, index) => (
                <div
                  key={file.path}
                  className={`selected-tab ${
                    activeFile?.path === file.path ? "active" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="tab-main"
                    onClick={() =>
                      updateActiveProject((project) => ({
                        ...project,
                        activePath: file.path,
                      }))
                    }
                    title={file.relativePath}
                  >
                    <strong>
                      {index + 1}. {file.relativePath}
                    </strong>
                    <span>{file.charCount.toLocaleString()} chars</span>
                  </button>

                  <div className="tab-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveSelectedFile(file.path, -1)}
                      aria-label="Move up"
                    >
                      ↑
                    </button>

                    <button
                      type="button"
                      disabled={index === selectedFiles.length - 1}
                      onClick={() => moveSelectedFile(file.path, 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>

                    <button
                      type="button"
                      onClick={() => removeSelectedFile(file.path)}
                      aria-label="Remove file"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {explorerView !== "remote" && (
  <section className="preview-card">
    <div className="panel-header split">
      <div>
        <h2>Output Preview</h2>
        <p>
          {activeFile
            ? `Active: ${activeFile.relativePath}`
            : "Final prompt text appears below."}
        </p>
      </div>

      <strong>
        {outputCharacterCount.toLocaleString()} chars
      </strong>
    </div>

    <textarea
      className="output-preview"
      value={promptOutput}
      readOnly
      spellCheck={false}
      placeholder={`personal-prompt.md
Your custom instructions...

relative/path.tsx
CODE`}
    />
  </section>
)}
        </section>
      </section>
    </main>
  );
}