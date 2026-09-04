export const GITHUB_COPILOT_BINARY_NAME = "copilot";

export const GITHUB_COPILOT_MIN_VERSION = "1.0.79";

export const GITHUB_COPILOT_INSTALL_COMMAND = "npm install -g @github/copilot@latest";

export const GITHUB_COPILOT_AUTH_COMMAND = "copilot login";

export function githubCopilotBinaryPathPlaceholder(platform: NodeJS.Platform): string {
  return platform === "win32" ? "C:\\path\\to\\copilot.exe" : "/absolute/path/to/copilot";
}
