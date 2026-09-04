import { WELL_KNOWN_BIN_DIRS } from "@/utils/binaryPath";
import { requireNodeModule } from "@/utils/desktopRuntime";
import { nodeToolBinDirCandidates, type NodeToolFs } from "@/utils/nodeToolBinDirs";

export interface GitHubCopilotBinaryResolverInput {
  override?: string;
  homeDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fs: NodeToolFs;
}

/** Resolve an external GitHub Copilot CLI executable or npm entry point. */
export function resolveGitHubCopilotBinary(input: GitHubCopilotBinaryResolverInput): string | null {
  // A configured path must win over discovery so users can pin a CLI installation.
  // https://github.com/logancyang/obsidian-copilot/issues/3096
  if (input.override && input.fs.existsSync(input.override)) {
    if (input.platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(input.override)) {
      return input.override;
    }
    const path = requireNodeModule<typeof import("node:path")>("path");
    const npmEntry = path.win32.join(
      path.win32.dirname(input.override),
      "node_modules",
      "@github",
      "copilot",
      "npm-loader.js"
    );
    // Windows npm shims cannot host the SDK protocol over stdio; the package
    // entry beside the shim can. https://github.com/logancyang/obsidian-copilot/issues/3096
    return input.fs.existsSync(npmEntry) ? npmEntry : null;
  }
  return githubCopilotCandidates(input).find((candidate) => input.fs.existsSync(candidate)) ?? null;
}

/** Directories inspected by {@link resolveGitHubCopilotBinary}. */
export function githubCopilotBinarySearchDirs(input: GitHubCopilotBinaryResolverInput): string[] {
  const path = requireNodeModule<typeof import("node:path")>("path");
  const pathImpl = input.platform === "win32" ? path.win32 : path.posix;
  return Array.from(
    new Set(githubCopilotCandidates(input).map((entry) => pathImpl.dirname(entry)))
  );
}

function githubCopilotCandidates(input: GitHubCopilotBinaryResolverInput): string[] {
  const path = requireNodeModule<typeof import("node:path")>("path");
  const pathImpl = input.platform === "win32" ? path.win32 : path.posix;
  const dirs = [
    ...nodeToolBinDirCandidates(input),
    ...(input.platform === "win32" ? [] : WELL_KNOWN_BIN_DIRS),
  ];
  // npm's Windows command shim cannot be spawned over stdio, so use the
  // package's JavaScript entry point when no native executable is present.
  // https://github.com/logancyang/obsidian-copilot/issues/3096
  if (input.platform === "win32") {
    return dirs.flatMap((dir) => [
      pathImpl.join(dir, "copilot.exe"),
      pathImpl.join(dir, "node_modules", "@github", "copilot", "npm-loader.js"),
    ]);
  }
  return dirs.flatMap((dir) => [
    pathImpl.join(dir, "copilot"),
    pathImpl.join(dir, "..", "lib", "node_modules", "@github", "copilot", "npm-loader.js"),
  ]);
}
