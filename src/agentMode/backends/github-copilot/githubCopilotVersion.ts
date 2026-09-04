import { compareSemver } from "@/utils/semver";
import { requireNodeModule } from "@/utils/desktopRuntime";
import { GITHUB_COPILOT_MIN_VERSION } from "./cliSetup";

const VERSION_TIMEOUT_MS = 10_000;

export interface GitHubCopilotVersionCompatibility {
  kind: "supported" | "incompatible";
  version: string;
  message?: string;
}

export interface GitHubCopilotCliInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function parseGitHubCopilotVersionOutput(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

/** Build a spawnable invocation for either a native CLI or npm's JavaScript entry point. */
export function githubCopilotCliInvocation(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): GitHubCopilotCliInvocation {
  // Obsidian's Electron executable can host npm CLI entry points when explicitly
  // placed in Node mode. https://github.com/logancyang/obsidian-copilot/issues/3096
  if (/\.[cm]?js$/i.test(binaryPath)) {
    return {
      command: process.execPath,
      args: [binaryPath, ...args],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { command: binaryPath, args, env };
}

/** Probe the selected CLI and enforce the protocol-compatible minimum release. */
export async function probeGitHubCopilotVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv
): Promise<GitHubCopilotVersionCompatibility> {
  const { execFile } = requireNodeModule<typeof import("node:child_process")>("child_process");
  const { promisify } = requireNodeModule<typeof import("node:util")>("util");
  const invocation = githubCopilotCliInvocation(binaryPath, ["--version"], env);
  const { stdout, stderr } = await promisify(execFile)(invocation.command, invocation.args, {
    timeout: VERSION_TIMEOUT_MS,
    env: invocation.env,
  });
  const version = parseGitHubCopilotVersionOutput(`${stdout}\n${stderr}`);
  // An executable that runs but does not identify a supported CLI is unsafe to
  // use as the JSON-RPC runtime. https://github.com/logancyang/obsidian-copilot/issues/3096
  if (!version) throw new Error("Could not read the installed GitHub Copilot CLI version.");
  // The SDK's protocol dependency establishes the oldest compatible external CLI.
  // https://github.com/logancyang/obsidian-copilot/issues/3096
  if (compareSemver(version, GITHUB_COPILOT_MIN_VERSION) < 0) {
    return {
      kind: "incompatible",
      version,
      message: `GitHub Copilot CLI ${version} is not supported. Version ${GITHUB_COPILOT_MIN_VERSION} or newer is required.`,
    };
  }
  return { kind: "supported", version };
}
