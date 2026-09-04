import type {
  CopilotClientOptions,
  PermissionHandler,
  SessionConfig,
  SessionEvent as CopilotSdkSessionEvent,
} from "@github/copilot-sdk";
import type { BackendDescriptor, SessionEvent } from "@/agentMode/session/types";
import {
  GitHubCopilotSdkBackendProcess,
  transcriptFromEvents,
  translateCopilotSdkEvent,
} from "./GitHubCopilotSdkBackendProcess";

const ISSUE = "https://github.com/logancyang/obsidian-copilot/issues/3096";
const forStdio = jest.fn((options) => ({ kind: "stdio", ...options }));
let clientOptions: CopilotClientOptions | undefined;
let sessionConfig: SessionConfig | undefined;
let eventHandler: ((event: CopilotSdkSessionEvent) => void) | undefined;
type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
let authStatus = { isAuthenticated: true, authType: "user" };
let listModelsError: Error | undefined;
let lastClient: FakeClient | undefined;

const disconnect = jest.fn().mockResolvedValue(undefined);
const abort = jest.fn().mockResolvedValue(undefined);
const setModel = jest.fn().mockResolvedValue(undefined);
const getEvents = jest.fn<Promise<CopilotSdkSessionEvent[]>, []>().mockResolvedValue([]);
const sendAndWait = jest.fn().mockImplementation(async () => {
  eventHandler?.(sdkEvent("assistant.message_delta", { messageId: "m1", deltaContent: "Hello" }));
  eventHandler?.(sdkEvent("session.idle", { aborted: false }));
});
const session = {
  sessionId: "session-1",
  on: jest.fn((handler: (event: CopilotSdkSessionEvent) => void) => {
    eventHandler = handler;
    return jest.fn();
  }),
  sendAndWait,
  abort,
  disconnect,
  setModel,
  getEvents,
};

class FakeClient {
  constructor(options: CopilotClientOptions) {
    clientOptions = options;
    // The fake exposes its latest instance for lifecycle assertions.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastClient = this;
  }

  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue([]);
  getAuthStatus = jest.fn().mockImplementation(async () => authStatus);
  listModels = jest.fn().mockImplementation(async () => {
    if (listModelsError) throw listModelsError;
    return [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        capabilities: {
          supports: { vision: true, reasoningEffort: true },
          limits: { max_context_window_tokens: 128_000 },
        },
        supportedReasoningEfforts: ["low", "high"],
      },
    ];
  });
  createSession = jest.fn().mockImplementation(async (config: SessionConfig) => {
    sessionConfig = config;
    return session;
  });
  resumeSession = jest.fn().mockImplementation(async (_id: string, config: SessionConfig) => {
    sessionConfig = config;
    return session;
  });
  listSessions = jest.fn().mockResolvedValue([
    {
      sessionId: "session-1",
      startTime: new Date("2026-01-01T00:00:00Z"),
      modifiedTime: new Date("2026-01-02T00:00:00Z"),
      summary: "Saved chat",
      isRemote: false,
      context: { workingDirectory: "/vault" },
    },
  ]);
}

const mockSdk = {
  CopilotClient: FakeClient,
  RuntimeConnection: { forStdio: (options: unknown) => forStdio(options) },
};

function sdkEvent(type: string, data: unknown): CopilotSdkSessionEvent {
  return {
    id: `${type}-id`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    data,
  } as CopilotSdkSessionEvent;
}

function descriptor(): BackendDescriptor {
  return {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    Icon: () => null,
    selfHostable: false,
    routesCopilotModels: false,
    setupDescription: "test",
    skillsProjectDir: ".github/skills",
    crossDiscoveredAgents: [],
    restartOnManagedSkillsChange: false,
    restartOnProviderConfigChange: false,
    restartOnSystemPromptChange: false,
    summarizesSessionTitle: true,
    getInstallState: () => ({ kind: "ready", source: "custom" }),
    subscribeInstallState: () => () => undefined,
    openInstallUI: () => undefined,
    createBackendProcess: () => {
      throw new Error("Not used by this test.");
    },
    applySelection: async () => undefined,
    wire: {
      encode: ({ baseModelId, effort }) => (effort ? `${baseModelId}/${effort}` : baseModelId),
      decode: (wireId) => {
        const [baseModelId, effort] = wireId.split("/");
        return { selection: { baseModelId, effort: effort ?? null }, provider: null };
      },
    },
    getModeMapping: () => ({
      kind: "setMode",
      canonical: { default: "default", plan: "plan", auto: "auto" },
      readOnlyModeId: "plan",
    }),
  };
}

function backend(binaryPath = "/usr/local/bin/copilot"): GitHubCopilotSdkBackendProcess {
  return new GitHubCopilotSdkBackendProcess({
    binaryPath,
    baseDirectory: "/copilot/vault",
    descriptor: descriptor(),
    getDefaultModelId: () => "gpt-5.4/high",
    getSystemPromptAppend: () => "Obsidian instructions",
    loadSdk: async () => mockSdk as never,
  });
}

describe("GitHubCopilotSdkBackendProcess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientOptions = undefined;
    sessionConfig = undefined;
    eventHandler = undefined;
    authStatus = { isAuthenticated: true, authType: "user" };
    listModelsError = undefined;
    lastClient = undefined;
    getEvents.mockResolvedValue([]);
  });

  describe("start()", () => {
    it(`${ISSUE} uses the configured external CLI over RuntimeConnection.forStdio`, async () => {
      const process = backend();
      await process.start();
      expect(forStdio).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/usr/local/bin/copilot",
          env: expect.any(Object),
        })
      );
      expect(clientOptions?.connection).toEqual(
        expect.objectContaining({ kind: "stdio", path: "/usr/local/bin/copilot" })
      );
      expect(clientOptions?.baseDirectory).toBe("/copilot/vault");
      expect(clientOptions?.env).toBeUndefined();
      expect(process.isRunning()).toBe(true);
    });

    it(`${ISSUE} reuses an already-running external runtime`, async () => {
      const process = backend();
      await process.start();
      const firstClient = lastClient;
      await process.start();
      expect(lastClient).toBe(firstClient);
      expect(forStdio).toHaveBeenCalledTimes(1);
    });

    it(`${ISSUE} stops the external runtime when model discovery fails during startup`, async () => {
      listModelsError = new Error("catalog unavailable");
      const process = backend();
      await expect(process.start()).rejects.toThrow("catalog unavailable");
      expect(lastClient?.stop).toHaveBeenCalled();
      expect(process.isRunning()).toBe(false);
    });

    it(`${ISSUE} launches an npm JavaScript entry through the host Node runtime`, async () => {
      const backendProcess = backend("C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js");
      await backendProcess.start();
      expect(forStdio).toHaveBeenCalledWith(
        expect.objectContaining({
          path: process.execPath,
          args: ["C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js"],
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
        })
      );
    });
  });

  describe("isRunning()", () => {
    it(`${ISSUE} reflects external runtime lifecycle state`, async () => {
      const process = backend();
      expect(process.isRunning()).toBe(false);
      await process.start();
      expect(process.isRunning()).toBe(true);
      await process.shutdown();
      expect(process.isRunning()).toBe(false);
    });
  });

  describe("newSession()", () => {
    it(`${ISSUE} creates a streaming SDK session with the selected model and workspace`, async () => {
      const process = backend();
      const opened = await process.newSession({ cwd: "/vault", additionalDirectories: ["/notes"] });
      expect(sessionConfig).toMatchObject({
        workingDirectory: "/vault",
        additionalDirectories: ["/notes"],
        model: "gpt-5.4",
        reasoningEffort: "high",
        systemMessage: { mode: "append", content: "Obsidian instructions" },
        streaming: true,
        enableSkills: true,
        enableConfigDiscovery: true,
      });
      expect(opened.sessionId).toBe("session-1");
      expect(opened.state.model?.current).toEqual({
        baseModelId: "gpt-5.4",
        effort: "high",
      });
      expect(opened.state.model?.availableModels[0]).toMatchObject({
        baseModelId: "gpt-5.4",
        effortOptions: [{ value: null }, { value: "low" }, { value: "high" }],
      });
    });

    it(`${ISSUE} refuses to create a session when the external CLI is not authenticated`, async () => {
      authStatus = { isAuthenticated: false, authType: "none" };
      const process = backend();
      await expect(process.newSession({ cwd: "/vault" })).rejects.toThrow(
        "GitHub Copilot CLI is not signed in"
      );
    });
  });

  describe("setPermissionPrompter()", () => {
    it(`${ISSUE} maps a selected permission decision to the SDK response`, async () => {
      const process = backend();
      process.setPermissionPrompter(async () => ({
        outcome: { outcome: "selected", optionId: "approve-once" },
      }));
      await process.newSession({ cwd: "/vault" });
      const onPermissionRequest = sessionConfig?.onPermissionRequest as PermissionHandler;
      await expect(
        onPermissionRequest(
          {
            kind: "read",
            path: "/vault/a.md",
            intention: "Read note",
          },
          { sessionId: "session-1" }
        )
      ).resolves.toEqual({ kind: "approve-once", approvedInteractively: true });
    });

    it(`${ISSUE} rejects unknown permission decisions instead of granting access`, async () => {
      const process = backend();
      process.setPermissionPrompter(async () => ({
        outcome: { outcome: "selected", optionId: "unexpected" },
      }));
      await process.newSession({ cwd: "/vault" });
      const onPermissionRequest = sessionConfig?.onPermissionRequest as PermissionHandler;
      await expect(
        onPermissionRequest(
          { kind: "read", path: "/vault/a.md", intention: "Read note" },
          { sessionId: "session-1" }
        )
      ).resolves.toEqual({ kind: "reject", feedback: "Unknown permission decision." });
    });

    it(`${ISSUE} rejects tool access when no host permission surface is registered`, async () => {
      const process = backend();
      await process.newSession({ cwd: "/vault" });
      const onPermissionRequest = sessionConfig?.onPermissionRequest as PermissionHandler;
      await expect(
        onPermissionRequest(
          { kind: "read", path: "/vault/a.md", intention: "Read note" },
          { sessionId: "session-1" }
        )
      ).resolves.toEqual({ kind: "reject", feedback: "No permission prompt is available." });
    });
  });

  describe("setReadOnlySessionPredicate()", () => {
    it(`${ISSUE} denies SDK writes in read-only sessions`, async () => {
      const process = backend();
      process.setReadOnlySessionPredicate(() => true);
      await process.newSession({ cwd: "/vault" });
      const onPermissionRequest = sessionConfig?.onPermissionRequest as PermissionHandler;
      await expect(
        onPermissionRequest(
          {
            kind: "write",
            fileName: "/vault/a.md",
            diff: "+change",
            intention: "Edit note",
            canOfferSessionApproval: true,
          },
          { sessionId: "session-1" }
        )
      ).resolves.toMatchObject({ kind: "reject" });
    });
  });

  describe("setAskUserQuestionPrompter()", () => {
    it(`${ISSUE} routes SDK user-input requests through the inline question adapter`, async () => {
      const process = backend();
      process.setAskUserQuestionPrompter(async () => ({ "Choose one": "Beta" }));
      await process.newSession({ cwd: "/vault" });
      const onUserInputRequest = sessionConfig?.onUserInputRequest as UserInputHandler;
      await expect(
        onUserInputRequest(
          { question: "Choose one", choices: ["Alpha", "Beta"] },
          { sessionId: "session-1" }
        )
      ).resolves.toEqual({ answer: "Beta", wasFreeform: false });
    });

    it(`${ISSUE} answers explicitly when no inline question surface is registered`, async () => {
      const process = backend();
      await process.newSession({ cwd: "/vault" });
      const onUserInputRequest = sessionConfig?.onUserInputRequest as UserInputHandler;
      await expect(
        onUserInputRequest({ question: "Continue?" }, { sessionId: "session-1" })
      ).resolves.toEqual({ answer: "", wasFreeform: true });
    });
  });

  describe("registerSessionHandler()", () => {
    it(`${ISSUE} flushes buffered SDK events when the session handler is registered`, async () => {
      const process = backend();
      const opened = await process.newSession({ cwd: "/vault" });
      eventHandler?.(
        sdkEvent("assistant.message_delta", { messageId: "m1", deltaContent: "Buffered" })
      );
      const updates: SessionEvent[] = [];
      process.registerSessionHandler(opened.sessionId, (event) => updates.push(event));
      expect(updates[0]?.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Buffered" },
      });
    });
  });

  describe("prompt()", () => {
    it(`${ISSUE} streams SDK response events through the backend session handler`, async () => {
      const process = backend();
      const opened = await process.newSession({ cwd: "/vault" });
      const updates: SessionEvent[] = [];
      process.registerSessionHandler(opened.sessionId, (event) => updates.push(event));
      await expect(
        process.prompt({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "Hi" }] })
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(updates[0]?.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      });
    });

    it(`${ISSUE} sends image blocks as native SDK blob attachments`, async () => {
      const process = backend();
      const opened = await process.newSession({ cwd: "/vault" });
      await process.prompt({
        sessionId: opened.sessionId,
        prompt: [
          { type: "text", text: "Describe this" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      });
      expect(sendAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Describe this",
          attachments: [{ type: "blob", data: "aW1hZ2U=", mimeType: "image/png" }],
        }),
        0x7fffffff
      );
    });
  });

  describe("cancel()", () => {
    it(`${ISSUE} aborts the owning SDK session`, async () => {
      const process = backend();
      const opened = await process.newSession({ cwd: "/vault" });
      await process.cancel({ sessionId: opened.sessionId });
      expect(abort).toHaveBeenCalled();
    });
  });

  describe("shutdown()", () => {
    it(`${ISSUE} disconnects sessions and stops the external runtime`, async () => {
      const process = backend();
      await process.newSession({ cwd: "/vault" });
      await process.shutdown();
      expect(disconnect).toHaveBeenCalled();
      expect(lastClient?.stop).toHaveBeenCalled();
      expect(process.isRunning()).toBe(false);
    });

    it(`${ISSUE} clears lifecycle state when SDK shutdown rejects`, async () => {
      const process = backend();
      await process.start();
      lastClient?.stop.mockRejectedValueOnce(new Error("stop failed"));
      await expect(process.shutdown()).rejects.toThrow("stop failed");
      expect(process.isRunning()).toBe(false);
    });
  });

  describe("onExit()", () => {
    it(`${ISSUE} notifies the registered listener when the backend shuts down`, async () => {
      const process = backend();
      const listener = jest.fn();
      process.onExit(listener);
      await process.start();
      await process.shutdown();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it(`${ISSUE} reports an unexpected CLI shutdown so the manager can restart the backend`, async () => {
      const process = backend();
      const listener = jest.fn();
      process.onExit(listener);
      await process.newSession({ cwd: "/vault" });

      eventHandler?.(
        sdkEvent("session.shutdown", {
          shutdownType: "error",
          codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: 0 },
          modelMetrics: {},
          sessionStartTime: 0,
        })
      );

      expect(process.isRunning()).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("readContextWindow()", () => {
    it(`${ISSUE} returns the selected SDK model context-window limit`, async () => {
      const process = backend();
      await process.start();
      await expect(process.readContextWindow("gpt-5.4/high")).resolves.toBe(128_000);
    });

    it(`${ISSUE} returns no context window before a model is selected`, async () => {
      await expect(backend().readContextWindow(null)).resolves.toBeNull();
    });
  });

  describe("listSessions()", () => {
    it(`${ISSUE} maps persisted SDK metadata into backend session records`, async () => {
      const process = backend();
      await expect(process.listSessions({})).resolves.toEqual({
        sessions: [
          expect.objectContaining({
            sessionId: "session-1",
            cwd: "/vault",
            title: "Saved chat",
          }),
        ],
      });
    });
  });

  describe("resumeSession()", () => {
    it(`${ISSUE} reconnects a persisted SDK session with its reconstructed state`, async () => {
      const process = backend();
      const resumed = await process.resumeSession({ sessionId: "session-1", cwd: "/vault" });
      expect(lastClient?.resumeSession).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ workingDirectory: "/vault" })
      );
      expect(resumed.state.model?.current).toEqual({
        baseModelId: "gpt-5.4",
        effort: null,
      });
    });
  });

  describe("loadSession()", () => {
    it(`${ISSUE} restores persisted model, effort, mode, and transcript on resume`, async () => {
      getEvents.mockResolvedValue([
        sdkEvent("session.resume", {
          eventCount: 2,
          resumeTime: "2026-01-01T00:00:00Z",
          selectedModel: "gpt-5.4",
          reasoningEffort: "high",
        }),
        sdkEvent("session.mode_changed", { previousMode: "interactive", newMode: "plan" }),
        sdkEvent("user.message", { content: "Question" }),
        sdkEvent("assistant.message", { content: "Answer" }),
      ]);
      const process = backend();
      const loaded = await process.loadSession({ sessionId: "session-1", cwd: "/vault" });
      expect(loaded.state.model?.current).toEqual({
        baseModelId: "gpt-5.4",
        effort: "high",
      });
      expect(loaded.state.mode?.current).toBe("plan");
      expect(loaded.transcript?.map((message) => message.message)).toEqual(["Question", "Answer"]);
    });

    it(`${ISSUE} normalizes unexposed persisted SDK modes to the interactive default`, async () => {
      getEvents.mockResolvedValue([
        sdkEvent("session.mode_changed", { previousMode: "interactive", newMode: "shell" }),
      ]);
      const process = backend();
      const loaded = await process.loadSession({ sessionId: "session-1", cwd: "/vault" });
      expect(loaded.state.mode?.current).toBe("default");
    });
  });

  describe("readPersistedTranscript()", () => {
    it(`${ISSUE} reads transcript events without keeping the SDK session connected`, async () => {
      getEvents.mockResolvedValue([
        sdkEvent("user.message", { content: "Question" }),
        sdkEvent("assistant.message", { content: "Answer" }),
      ]);
      const process = backend();
      const transcript = await process.readPersistedTranscript({
        sessionId: "session-1",
        cwd: "/vault",
      });
      expect(transcript.map((message) => message.message)).toEqual(["Question", "Answer"]);
      expect(disconnect).toHaveBeenCalled();
    });
  });

  describe("supportsAdditionalDirectories()", () => {
    it(`${ISSUE} reports support for additional SDK workspace roots`, () => {
      expect(backend().supportsAdditionalDirectories()).toBe(true);
    });
  });

  describe("setSessionModel()", () => {
    it(`${ISSUE} applies model and reasoning-effort changes without restarting the session`, async () => {
      const process = backend();
      await process.newSession({ cwd: "/vault" });
      await process.setSessionModel({ sessionId: "session-1", modelId: "gpt-5.4/low" });
      expect(setModel).toHaveBeenCalledWith("gpt-5.4", { reasoningEffort: "low" });
    });
  });

  describe("isSetSessionModelSupported()", () => {
    it(`${ISSUE} reports live SDK model switching as supported`, () => {
      expect(backend().isSetSessionModelSupported()).toBe(true);
    });
  });

  describe("setSessionMode()", () => {
    it(`${ISSUE} applies mode changes to subsequent prompts without restarting the session`, async () => {
      const process = backend();
      await process.newSession({ cwd: "/vault" });
      const state = await process.setSessionMode({ sessionId: "session-1", modeId: "auto" });
      expect(state.mode?.current).toBe("auto");
      await process.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Continue" }],
      });
      expect(sendAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Continue", agentMode: "autopilot" }),
        0x7fffffff
      );
    });

    it(`${ISSUE} normalizes unsupported mode changes in state updates and subsequent prompts`, async () => {
      const process = backend();
      const updates: SessionEvent[] = [];
      await process.newSession({ cwd: "/vault" });
      process.registerSessionHandler("session-1", (event) => updates.push(event));

      const state = await process.setSessionMode({ sessionId: "session-1", modeId: "shell" });
      await process.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Continue" }],
      });

      expect(state.mode?.current).toBe("default");
      expect(updates).toContainEqual({
        sessionId: "session-1",
        update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
      });
      expect(sendAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ agentMode: "interactive" }),
        0x7fffffff
      );
    });
  });

  describe("isSetSessionModeSupported()", () => {
    it(`${ISSUE} reports per-message SDK mode switching as supported`, () => {
      expect(backend().isSetSessionModeSupported()).toBe(true);
    });
  });

  describe("setSessionConfigOption()", () => {
    it(`${ISSUE} rejects unsupported SDK session configuration options`, async () => {
      const process = backend();
      await expect(process.setSessionConfigOption()).rejects.toThrow("session/set_config_option");
    });
  });

  describe("isSetSessionConfigOptionSupported()", () => {
    it(`${ISSUE} reports SDK session configuration options as unsupported`, () => {
      expect(backend().isSetSessionConfigOptionSupported()).toBe(false);
    });
  });

  describe("translateCopilotSdkEvent()", () => {
    it(`${ISSUE} translates streaming text, tool, title, and usage events`, () => {
      expect(
        translateCopilotSdkEvent(
          "session-1",
          sdkEvent("assistant.message_delta", { messageId: "m1", deltaContent: "hello" })
        )[0]?.update
      ).toMatchObject({ sessionUpdate: "agent_message_chunk" });
      expect(
        translateCopilotSdkEvent(
          "session-1",
          sdkEvent("tool.execution_start", {
            toolCallId: "tool-1",
            toolName: "read_file",
            arguments: { path: "a.md" },
          })
        )[0]?.update
      ).toMatchObject({ sessionUpdate: "tool_call", kind: "read" });
      expect(
        translateCopilotSdkEvent(
          "session-1",
          sdkEvent("session.title_changed", { title: "New title" })
        )[0]?.update
      ).toEqual({ sessionUpdate: "session_info_update", title: "New title" });
      expect(
        translateCopilotSdkEvent(
          "session-1",
          sdkEvent("session.usage_info", {
            currentTokens: 100,
            tokenLimit: 1000,
            messagesLength: 2,
          })
        )[0]?.update
      ).toMatchObject({
        sessionUpdate: "usage_update",
        usage: { usedTokens: 100, contextWindow: 1000 },
      });
    });
  });

  describe("transcriptFromEvents()", () => {
    it(`${ISSUE} reconstructs only persisted user and assistant text messages`, () => {
      const transcript = transcriptFromEvents([
        sdkEvent("user.message", { content: "Question" }),
        sdkEvent("tool.execution_progress", {
          toolCallId: "tool-1",
          progressMessage: "Working",
        }),
        sdkEvent("assistant.message", { content: "Answer" }),
      ]);
      expect(transcript.map(({ sender, message }) => ({ sender, message }))).toEqual([
        { sender: "user", message: "Question" },
        { sender: "assistant", message: "Answer" },
      ]);
    });
  });
});
