import { Bot } from "lucide-react";
import type { AgentSession } from "@/agentMode/session/AgentSession";
import { agentOriginEnabledModelEntries } from "@/agentMode/backends/shared/agentEnabledModels";
import type {
  BackendDescriptor,
  BackendProcess,
  EnabledModelEntry,
  InstallState,
  ModelSelection,
  ModelWireCodec,
  ModeMapping,
} from "@/agentMode/session/types";
import { GitHubCopilotSdkBackendProcess } from "@/agentMode/sdk/GitHubCopilotSdkBackendProcess";
import { buildAgentSystemPrompt } from "@/agentMode/backends/shared/agentSystemPrompt";
import { getSettings, type CopilotSettings } from "@/settings/model";
import { copilotAppDataDir, getVaultId } from "@/utils/appPaths";
import { requireNodeModule } from "@/utils/desktopRuntime";
import { detectBinary } from "@/utils/detectBinary";
import { Notice } from "obsidian";
import {
  githubCopilotBinarySearchDirs,
  resolveGitHubCopilotBinary,
} from "./githubCopilotBinaryResolver";
import {
  GITHUB_COPILOT_BINARY_NAME,
  GITHUB_COPILOT_INSTALL_COMMAND,
  GITHUB_COPILOT_MIN_VERSION,
} from "./cliSetup";
import { probeGitHubCopilotVersion } from "./githubCopilotVersion";

const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ABSENT_STATE: InstallState = Object.freeze({ kind: "absent" });
let binaryPath: string | null = null;
let installState: InstallState = ABSENT_STATE;
const listeners = new Set<() => void>();

function resolverInput(): Omit<Parameters<typeof resolveGitHubCopilotBinary>[0], "override"> {
  const fs = requireNodeModule<typeof import("node:fs")>("fs");
  const os = requireNodeModule<typeof import("node:os")>("os");
  return {
    homeDir: os.homedir(),
    platform: process.platform,
    env: process.env,
    fs: {
      existsSync: (path) => fs.existsSync(path),
      readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
      readdirSync: (path) => fs.readdirSync(path),
    },
  };
}

async function refreshInstallState(): Promise<void> {
  binaryPath =
    resolveGitHubCopilotBinary({ override: undefined, ...resolverInput() }) ??
    (await detectBinary(GITHUB_COPILOT_BINARY_NAME));
  if (!binaryPath) {
    installState = ABSENT_STATE;
  } else {
    try {
      const result = await probeGitHubCopilotVersion(binaryPath, process.env);
      installState =
        result.kind === "supported"
          ? { kind: "ready", source: "custom" }
          : {
              kind: "incompatible",
              source: "custom",
              currentVersion: result.version,
              minVersion: GITHUB_COPILOT_MIN_VERSION,
              message: result.message ?? "Unsupported GitHub Copilot CLI version.",
            };
    } catch (error) {
      installState = {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  for (const listener of listeners) listener();
}

const wire: ModelWireCodec = {
  encode: ({ baseModelId, effort }) => (effort ? `${baseModelId}/${effort}` : baseModelId),
  decode: (wireId) => {
    const segments = wireId.split("/");
    const effort = segments.at(-1);
    return effort && KNOWN_EFFORTS.has(effort)
      ? {
          selection: { baseModelId: segments.slice(0, -1).join("/"), effort },
          provider: null,
        }
      : { selection: { baseModelId: wireId, effort: null }, provider: null };
  },
};

/** GitHub Copilot CLI backend driven through the official SDK over stdio. */
export const GitHubCopilotBackendDescriptor: BackendDescriptor = {
  id: "github-copilot",
  displayName: "GitHub Copilot",
  Icon: Bot,
  selfHostable: false,
  routesCopilotModels: false,
  setupDescription: "GitHub-hosted models, billed to your Copilot plan.",
  skillsProjectDir: ".github/skills",
  crossDiscoveredAgents: ["claude", "codex"],
  restartOnManagedSkillsChange: false,
  restartOnProviderConfigChange: false,
  restartOnSystemPromptChange: false,
  summarizesSessionTitle: true,
  wire,
  showModelDescriptions: true,
  getEnabledModelEntries(settings: CopilotSettings): readonly EnabledModelEntry[] {
    return agentOriginEnabledModelEntries(settings, "github-copilot", (wireId) =>
      wire.decode(wireId)
    );
  },
  getInstallState(): InstallState {
    return installState;
  },
  getResolvedBinaryPath(): string | null {
    return binaryPath;
  },
  subscribeInstallState(_plugin, listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async onPluginLoad(): Promise<void> {
    await refreshInstallState();
  },
  openInstallUI(): void {
    new Notice(
      `Run "${GITHUB_COPILOT_INSTALL_COMMAND}", then "copilot login", and reload Copilot.`
    );
  },
  async applySelection(session: AgentSession, selection: ModelSelection): Promise<void> {
    await session.applyModelWireId(wire.encode(selection));
  },
  createBackendProcess(args): BackendProcess {
    if (!binaryPath) throw new Error("GitHub Copilot CLI is not installed.");
    return new GitHubCopilotSdkBackendProcess({
      binaryPath,
      baseDirectory: requireNodeModule<typeof import("node:path")>("path").join(
        copilotAppDataDir(requireNodeModule<typeof import("node:os")>("os").homedir()),
        "vaults",
        getVaultId(args.app),
        "github-copilot"
      ),
      descriptor: args.descriptor,
      getDefaultModelId: () => {
        const selection = getSettings().agentMode.backends["github-copilot"]?.defaultModel;
        return selection ? wire.encode(selection) : undefined;
      },
      getSystemPromptAppend: buildAgentSystemPrompt,
    });
  },
  getModeMapping(): ModeMapping {
    return {
      kind: "setMode",
      canonical: { default: "default", plan: "plan", auto: "auto" },
      readOnlyModeId: "plan",
    };
  },
};

export { githubCopilotBinarySearchDirs };
