import type {
  CopilotClient,
  CopilotSession,
  MessageOptions,
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent as CopilotSdkSessionEvent,
} from "@github/copilot-sdk";
import { AuthRequiredError, MethodUnsupportedError } from "@/agentMode/session/errors";
import { translateBackendState } from "@/agentMode/session/translateBackendState";
import type {
  AgentChatMessage,
  AgentQuestionAnswers,
  AskUserQuestionPrompt,
  BackendDescriptor,
  BackendModelInfo,
  BackendProcess,
  BackendState,
  CancelInput,
  ListSessionsInput,
  ListSessionsOutput,
  LoadSessionInput,
  LoadSessionOutput,
  OpenSessionInput,
  OpenSessionOutput,
  PermissionDecision,
  PermissionOption,
  PermissionPrompt,
  PromptContent,
  PromptInput,
  PromptOutput,
  RawModeState,
  RawModelState,
  ResumeSessionInput,
  ResumeSessionOutput,
  SessionEvent,
  SessionId,
  SessionUpdateHandler,
  StopReason,
  ToolCallContent,
  ToolCallSnapshot,
} from "@/agentMode/session/types";
import { formatDateTime } from "@/utils";
import { v4 as uuidv4 } from "uuid";

type AgentMode = NonNullable<MessageOptions["agentMode"]>;
type GitHubCopilotSdkModule = Pick<
  typeof import("@github/copilot-sdk"),
  "CopilotClient" | "RuntimeConnection"
>;
type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

interface GitHubCopilotCliInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface GitHubCopilotSdkBackendProcessOptions {
  binaryPath: string;
  baseDirectory: string;
  descriptor: BackendDescriptor;
  getDefaultModelId?: () => string | undefined;
  getSystemPromptAppend?: () => string | undefined;
  loadSdk?: () => Promise<GitHubCopilotSdkModule>;
}

function normalizeAgentMode(mode: string): AgentMode {
  if (mode === "plan") return "plan";
  if (mode === "autopilot") return "autopilot";
  // Shell and future SDK modes are not exposed by Agent Mode, so resume them
  // safely as the interactive default. https://github.com/logancyang/obsidian-copilot/issues/3096
  return "interactive";
}

interface LiveSession {
  session: CopilotSession;
  cwd: string;
  modelId: string | null;
  mode: AgentMode;
  lastStopReason: StopReason;
  unsubscribe: () => void;
}

const MODES: RawModeState["availableModes"] = [
  { id: "default", name: "Ask" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Autopilot" },
];

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: "approve-once", name: "Allow once", kind: "allow_once" },
  { optionId: "approve-for-session", name: "Allow for session", kind: "allow_always" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
];

/**
 * Adapts the official GitHub Copilot SDK to Agent Mode's backend-neutral session contract.
 *
 * The SDK is always connected to a user-installed CLI with
 * `RuntimeConnection.forStdio({ path })`; this class never uses the SDK's bundled runtime.
 */
export class GitHubCopilotSdkBackendProcess implements BackendProcess {
  private client: CopilotClient | null = null;
  private running = false;
  private readonly sessions = new Map<SessionId, LiveSession>();
  private readonly handlers = new Map<SessionId, SessionUpdateHandler>();
  private readonly pendingEvents = new Map<SessionId, SessionEvent[]>();
  private readonly exitListeners = new Set<() => void>();
  private permissionPrompter: ((req: PermissionPrompt) => Promise<PermissionDecision>) | null =
    null;
  private askUserQuestionPrompter:
    | ((req: AskUserQuestionPrompt) => Promise<AgentQuestionAnswers>)
    | null = null;
  private readOnlySessionPredicate: ((sessionId: SessionId) => boolean) | null = null;
  private models: ModelInfo[] = [];

  constructor(private readonly opts: GitHubCopilotSdkBackendProcessOptions) {}

  async start(): Promise<void> {
    // AgentSessionManager may preload a process before the first chat asks for
    // it; repeated starts must reuse that runtime. https://github.com/logancyang/obsidian-copilot/issues/3096
    if (this.running) return;
    const sdk = this.opts.loadSdk ? await this.opts.loadSdk() : await import("@github/copilot-sdk");
    const env = buildRuntimeEnv();
    const invocation = githubCopilotCliInvocation(this.opts.binaryPath, env);
    const client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forStdio({
        path: invocation.command,
        args: invocation.args,
        env: definedRuntimeEnv(invocation.env),
      }),
      baseDirectory: this.opts.baseDirectory,
      useLoggedInUser: true,
    });
    try {
      await client.start();
      const models = await client.listModels();
      this.client = client;
      this.models = models;
      this.running = true;
    } catch (error) {
      // A failed catalog read must not leak the external runtime started just
      // before it. https://github.com/logancyang/obsidian-copilot/issues/3096
      let cleanupErrors: unknown[];
      try {
        cleanupErrors = await client.stop();
      } catch (cleanupError) {
        cleanupErrors = [cleanupError];
      }
      if (cleanupErrors.length > 0) {
        throw new Error(
          `GitHub Copilot SDK startup failed: ${String(error)}; cleanup failed: ${cleanupErrors
            .map(String)
            .join("; ")}`
        );
      }
      throw error;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  setPermissionPrompter(fn: (req: PermissionPrompt) => Promise<PermissionDecision>): void {
    this.permissionPrompter = fn;
  }

  setAskUserQuestionPrompter(
    fn: (req: AskUserQuestionPrompt) => Promise<AgentQuestionAnswers>
  ): void {
    this.askUserQuestionPrompter = fn;
  }

  setReadOnlySessionPredicate(fn: (sessionId: SessionId) => boolean): void {
    this.readOnlySessionPredicate = fn;
  }

  registerSessionHandler(sessionId: SessionId, handler: SessionUpdateHandler): () => void {
    this.handlers.set(sessionId, handler);
    const queued = this.pendingEvents.get(sessionId);
    if (queued) {
      this.pendingEvents.delete(sessionId);
      for (const event of queued) handler(event);
    }
    return () => {
      if (this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
    };
  }

  async newSession(params: OpenSessionInput): Promise<OpenSessionOutput> {
    const client = await this.requireClient();
    await this.assertAuthenticated(client);
    const selectedModel = this.opts.getDefaultModelId?.();
    const session = await client.createSession(
      this.sessionConfig(params.cwd, params.additionalDirectories, selectedModel)
    );
    return this.attachSession(session, params.cwd, selectedModel ?? null, "interactive");
  }

  async prompt(params: PromptInput): Promise<PromptOutput> {
    const live = this.requireSession(params.sessionId);
    const message = promptToMessageOptions(params.prompt, live.mode);
    live.lastStopReason = "end_turn";
    await live.session.sendAndWait(message, 0x7fffffff);
    return { stopReason: live.lastStopReason };
  }

  async cancel(params: CancelInput): Promise<void> {
    await this.requireSession(params.sessionId).session.abort();
  }

  async setSessionModel(params: { sessionId: SessionId; modelId: string }): Promise<BackendState> {
    const live = this.requireSession(params.sessionId);
    const decoded = this.opts.descriptor.wire.decode(params.modelId).selection;
    await live.session.setModel(decoded.baseModelId, {
      reasoningEffort: toSdkReasoningEffort(decoded.effort),
    });
    live.modelId = params.modelId;
    return this.stateFor(live);
  }

  isSetSessionModelSupported(): boolean {
    return true;
  }

  async setSessionMode(params: { sessionId: SessionId; modeId: string }): Promise<BackendState> {
    const live = this.requireSession(params.sessionId);
    live.mode = modeIdToAgentMode(params.modeId);
    const currentModeId = agentModeToModeId(live.mode);
    this.dispatch({
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId },
    });
    return this.stateFor(live);
  }

  isSetSessionModeSupported(): boolean {
    return true;
  }

  async setSessionConfigOption(): Promise<BackendState> {
    throw new MethodUnsupportedError("session/set_config_option");
  }

  isSetSessionConfigOptionSupported(): boolean {
    return false;
  }

  async listSessions(params: ListSessionsInput): Promise<ListSessionsOutput> {
    const client = await this.requireClient();
    const sessions = await client.listSessions(
      params.cwd ? { workingDirectory: params.cwd } : undefined
    );
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.context?.workingDirectory ?? params.cwd ?? "",
        title: session.summary ?? null,
        updatedAt: session.modifiedTime.toISOString(),
      })),
    };
  }

  async resumeSession(params: ResumeSessionInput): Promise<ResumeSessionOutput> {
    const client = await this.requireClient();
    await this.assertAuthenticated(client);
    const session = await client.resumeSession(
      params.sessionId,
      this.sessionConfig(params.cwd, params.additionalDirectories)
    );
    const restored = persistedSessionSelection(await session.getEvents(), this.opts.descriptor);
    return this.attachSession(session, params.cwd, restored.modelId, restored.mode);
  }

  async loadSession(params: LoadSessionInput): Promise<LoadSessionOutput> {
    const opened = await this.resumeSession(params);
    const live = this.requireSession(params.sessionId);
    return {
      ...opened,
      transcript: transcriptFromEvents(await live.session.getEvents()),
    };
  }

  async readPersistedTranscript(params: {
    sessionId: SessionId;
    cwd: string;
  }): Promise<AgentChatMessage[]> {
    const client = await this.requireClient();
    const live = this.sessions.get(params.sessionId);
    if (live) return transcriptFromEvents(await live.session.getEvents());
    // A transcript read must not leave a resumed SDK session attached after
    // history inspection completes. https://github.com/logancyang/obsidian-copilot/issues/3096
    const session = await client.resumeSession(params.sessionId, this.sessionConfig(params.cwd));
    try {
      return transcriptFromEvents(await session.getEvents());
    } finally {
      await session.disconnect();
    }
  }

  async readContextWindow(wireModelId: string | null | undefined): Promise<number | null> {
    // A chat without a selected model has no model-specific window to seed.
    // https://github.com/logancyang/obsidian-copilot/issues/3096
    if (!wireModelId) return null;
    const baseModelId = this.opts.descriptor.wire.decode(wireModelId).selection.baseModelId;
    return (
      this.models.find((model) => model.id === baseModelId)?.capabilities.limits
        .max_context_window_tokens ?? null
    );
  }

  supportsAdditionalDirectories(): boolean {
    return true;
  }

  async shutdown(): Promise<void> {
    const disconnectErrors: unknown[] = [];
    for (const live of this.sessions.values()) {
      live.unsubscribe();
      try {
        await live.session.disconnect();
      } catch (error) {
        disconnectErrors.push(error);
      }
    }
    this.sessions.clear();
    // Always clear lifecycle state and notify listeners even when the SDK rejects
    // its own cleanup. https://github.com/logancyang/obsidian-copilot/issues/3096
    let errors: unknown[] = [];
    if (this.client) {
      try {
        errors = await this.client.stop();
      } catch (error) {
        errors = [error];
      }
    }
    this.client = null;
    this.running = false;
    for (const listener of this.exitListeners) listener();
    const allErrors = [...disconnectErrors, ...errors];
    if (allErrors.length > 0) {
      throw new Error(`GitHub Copilot SDK shutdown failed: ${allErrors.map(String).join("; ")}`);
    }
  }

  private async requireClient(): Promise<CopilotClient> {
    if (!this.running) await this.start();
    if (!this.client) throw new Error("GitHub Copilot SDK client did not start.");
    return this.client;
  }

  private requireSession(sessionId: SessionId): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`Unknown GitHub Copilot session: ${sessionId}`);
    return live;
  }

  private async assertAuthenticated(client: CopilotClient): Promise<void> {
    const status = await client.getAuthStatus();
    // Do not open a session until the external CLI confirms that it has usable credentials.
    // https://github.com/logancyang/obsidian-copilot/issues/3096
    if (!status.isAuthenticated) {
      throw new AuthRequiredError(
        status.statusMessage ?? "GitHub Copilot CLI is not signed in. Run /login in the CLI."
      );
    }
  }

  private sessionConfig(
    cwd: string,
    additionalDirectories?: string[],
    wireModelId?: string
  ): SessionConfig {
    const selection = wireModelId
      ? this.opts.descriptor.wire.decode(wireModelId).selection
      : undefined;
    return {
      workingDirectory: cwd,
      additionalDirectories,
      model: selection?.baseModelId,
      reasoningEffort: toSdkReasoningEffort(selection?.effort),
      streaming: true,
      enableSkills: true,
      enableConfigDiscovery: true,
      systemMessage: { mode: "append", content: this.opts.getSystemPromptAppend?.() },
      onPermissionRequest: (request, invocation) =>
        this.handlePermission(invocation.sessionId, request),
      onUserInputRequest: (request, invocation) =>
        this.handleUserInput(invocation.sessionId, request),
    };
  }

  private attachSession(
    session: CopilotSession,
    cwd: string,
    modelId: string | null,
    mode: AgentMode
  ): OpenSessionOutput {
    const sessionId = session.sessionId;
    const live: LiveSession = {
      session,
      cwd,
      modelId,
      mode,
      lastStopReason: "end_turn",
      unsubscribe: () => undefined,
    };
    live.unsubscribe = session.on((event) => this.handleEvent(sessionId, event));
    this.sessions.get(sessionId)?.unsubscribe();
    this.sessions.set(sessionId, live);
    return { sessionId, state: this.stateFor(live) };
  }

  private stateFor(live: LiveSession): BackendState {
    const models: RawModelState | null =
      this.models.length > 0
        ? {
            currentModelId: live.modelId ?? this.models[0].id,
            availableModels: this.models.flatMap(modelToBackendModels),
          }
        : null;
    const modes: RawModeState = {
      currentModeId: agentModeToModeId(live.mode),
      availableModes: [...MODES],
    };
    return translateBackendState({ models, modes, configOptions: null }, this.opts.descriptor);
  }

  private handleEvent(sessionId: SessionId, event: CopilotSdkSessionEvent): void {
    const live = this.sessions.get(sessionId);
    if (event.type === "session.shutdown" && event.data.shutdownType === "error") {
      // A crashed CLI cannot serve any session on this client. Mark it dead so
      // the manager creates a fresh backend instead of reusing the broken one.
      // https://github.com/logancyang/obsidian-copilot/issues/3096
      this.running = false;
      for (const listener of this.exitListeners) listener();
    }
    if (live && event.type === "session.idle") {
      live.lastStopReason = event.data.aborted ? "cancelled" : "end_turn";
    }
    if (live && event.type === "session.model_change") {
      live.modelId = this.opts.descriptor.wire.encode({
        baseModelId: event.data.newModel,
        effort: event.data.reasoningEffort ?? null,
      });
      this.dispatch({
        sessionId,
        update: { sessionUpdate: "state_changed", state: this.stateFor(live) },
      });
    }
    if (live && event.type === "session.mode_changed") {
      live.mode = normalizeAgentMode(event.data.newMode);
      this.dispatch({
        sessionId,
        update: { sessionUpdate: "state_changed", state: this.stateFor(live) },
      });
    }
    const translated = translateCopilotSdkEvent(sessionId, event);
    for (const update of translated) this.dispatch(update);
  }

  private dispatch(event: SessionEvent): void {
    const handler = this.handlers.get(event.sessionId);
    if (handler) {
      handler(event);
      return;
    }
    const queued = this.pendingEvents.get(event.sessionId) ?? [];
    queued.push(event);
    this.pendingEvents.set(event.sessionId, queued);
  }

  private async handlePermission(
    sessionId: SessionId,
    request: PermissionRequest
  ): Promise<PermissionRequestResult> {
    if (this.readOnlySessionPredicate?.(sessionId) && !permissionIsReadOnly(request)) {
      return {
        kind: "reject",
        feedback: "Read-only QA turn: write and execute tools are disabled.",
      };
    }

    // Missing or unrecognized host decisions must fail closed rather than let
    // an SDK tool run. https://github.com/logancyang/obsidian-copilot/issues/3096
    if (!this.permissionPrompter) {
      return { kind: "reject", feedback: "No permission prompt is available." };
    }

    const decision = await this.permissionPrompter(permissionPrompt(sessionId, request));
    if (decision.outcome.outcome === "cancelled") {
      return { kind: "reject", feedback: decision.denyMessage ?? "User cancelled." };
    }
    switch (decision.outcome.optionId) {
      case "approve-once":
        return { kind: "approve-once", approvedInteractively: true };
      case "approve-for-session":
        return { kind: "approve-for-session" };
      case "reject":
        return { kind: "reject", feedback: decision.denyMessage ?? "User declined." };
      default:
        // Unknown UI decisions must never silently grant tool access.
        // https://github.com/logancyang/obsidian-copilot/issues/3096
        return { kind: "reject", feedback: "Unknown permission decision." };
    }
  }

  private async handleUserInput(
    sessionId: SessionId,
    request: UserInputRequest
  ): Promise<UserInputResponse> {
    // An unavailable question surface is an explicit empty response, never a
    // hanging SDK request. https://github.com/logancyang/obsidian-copilot/issues/3096
    if (!this.askUserQuestionPrompter) {
      return { answer: "", wasFreeform: true };
    }
    const answers = await this.askUserQuestionPrompter({
      sessionId,
      requestId: uuidv4(),
      questions: [
        {
          question: request.question,
          options: (request.choices ?? []).map((choice) => ({ label: choice })),
        },
      ],
    });
    const answer = answers[request.question] ?? "";
    return {
      answer,
      wasFreeform: !request.choices?.includes(answer),
    };
  }
}

function githubCopilotCliInvocation(
  binaryPath: string,
  env: NodeJS.ProcessEnv
): GitHubCopilotCliInvocation {
  if (!/\.[cm]?js$/i.test(binaryPath)) return { command: binaryPath, args: [], env };
  return {
    command: process.execPath,
    args: [binaryPath],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

function buildRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function definedRuntimeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function promptToMessageOptions(prompt: PromptContent[], mode: AgentMode): MessageOptions {
  const text: string[] = [];
  const attachments: NonNullable<MessageOptions["attachments"]> = [];
  for (const block of prompt) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (block.type === "image") {
      // Keep binary image data out of prompt text by using the SDK's native
      // blob attachment. https://github.com/logancyang/obsidian-copilot/issues/3096
      attachments.push({ type: "blob", data: block.data, mimeType: block.mimeType });
    } else {
      // URI resources have no SDK attachment counterpart, so preserve their
      // identity in text. https://github.com/logancyang/obsidian-copilot/issues/3096
      text.push(`[Attached resource: ${block.name ?? block.uri}]`);
    }
  }
  return {
    prompt: text.join("\n"),
    attachments: attachments.length > 0 ? attachments : undefined,
    agentMode: mode,
  };
}

function modelToBackendModels(model: ModelInfo): BackendModelInfo[] {
  const base: BackendModelInfo = {
    modelId: model.id,
    name: model.name,
    description: `${model.capabilities.limits.max_context_window_tokens.toLocaleString()} token context`,
  };
  if (!model.capabilities.supports.reasoningEffort || !model.supportedReasoningEfforts?.length) {
    return [base];
  }
  return [
    base,
    ...model.supportedReasoningEfforts.map((effort) => ({
      ...base,
      modelId: `${model.id}/${effort}`,
      name: `${model.name} (${effort})`,
    })),
  ];
}

function modeIdToAgentMode(modeId: string): AgentMode {
  if (modeId === "plan") return "plan";
  if (modeId === "auto") return "autopilot";
  // The backend exposes only interactive, plan, and autopilot. Normalize stale or
  // SDK-only modes so the UI and subsequent prompts cannot diverge.
  // https://github.com/logancyang/obsidian-copilot/issues/3096
  return "interactive";
}

function agentModeToModeId(mode: AgentMode): string {
  if (mode === "plan") return "plan";
  if (mode === "autopilot") return "auto";
  return "default";
}

function toSdkReasoningEffort(effort: string | null | undefined): ReasoningEffort | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    default:
      return undefined;
  }
}

function persistedSessionSelection(
  events: readonly CopilotSdkSessionEvent[],
  descriptor: BackendDescriptor
): { modelId: string | null; mode: AgentMode } {
  let baseModelId: string | undefined;
  let effort: string | null = null;
  let mode: AgentMode = "interactive";
  for (const event of events) {
    if (event.type === "session.start" || event.type === "session.resume") {
      baseModelId = event.data.selectedModel ?? baseModelId;
      effort = event.data.reasoningEffort ?? effort;
    } else if (event.type === "session.model_change") {
      baseModelId = event.data.newModel;
      effort = event.data.reasoningEffort ?? null;
    } else if (event.type === "session.mode_changed") {
      mode = normalizeAgentMode(event.data.newMode);
    }
  }
  return {
    modelId: baseModelId ? descriptor.wire.encode({ baseModelId, effort }) : null,
    mode,
  };
}

function permissionIsReadOnly(request: PermissionRequest): boolean {
  if (request.kind === "read" || request.kind === "url") return true;
  if (request.kind === "mcp") return request.readOnly;
  if (request.kind === "shell") {
    return (
      !request.hasWriteFileRedirection && request.commands.every((command) => command.readOnly)
    );
  }
  return false;
}

function permissionPrompt(sessionId: SessionId, request: PermissionRequest): PermissionPrompt {
  const toolCallId =
    ("toolCallId" in request && request.toolCallId) || `github-copilot-${uuidv4()}`;
  const snapshot = permissionToolCall(toolCallId, request);
  const canApproveForSession =
    request.kind !== "shell" && request.kind !== "write" ? true : request.canOfferSessionApproval;
  return {
    sessionId,
    toolCall: snapshot,
    options: canApproveForSession
      ? [...PERMISSION_OPTIONS]
      : PERMISSION_OPTIONS.filter((option) => option.kind !== "allow_always"),
  };
}

function permissionToolCall(toolCallId: string, request: PermissionRequest): ToolCallSnapshot {
  const title = permissionTitle(request);
  const path =
    request.kind === "write"
      ? request.fileName
      : request.kind === "read"
        ? request.path
        : undefined;
  return {
    toolCallId,
    title,
    kind: permissionToolKind(request),
    status: "pending",
    rawInput: request,
    locations: path ? [{ path }] : undefined,
    vendorToolName: request.kind,
    mcpServer: request.kind === "mcp" ? request.serverName : undefined,
  };
}

function permissionTitle(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText;
    case "write":
      return `Write ${request.fileName}`;
    case "read":
      return `Read ${request.path}`;
    case "mcp":
      return request.toolTitle || request.toolName;
    case "url":
      return `Fetch ${request.url}`;
    case "memory":
      return `${request.action ?? "Use"} memory`;
    case "custom-tool":
      return request.toolDescription || request.toolName;
    case "hook":
      return request.hookMessage || request.toolName;
    case "extension-management":
      return `${request.operation} extension`;
    case "factory":
      return `${request.operation} factory ${request.name}`;
    case "extension-permission-access":
      return `Allow ${request.extensionName} capabilities`;
  }
}

function permissionToolKind(request: PermissionRequest): ToolCallSnapshot["kind"] {
  if (request.kind === "read") return "read";
  if (request.kind === "write") return "edit";
  if (request.kind === "shell") return "execute";
  if (request.kind === "url") return "fetch";
  return "other";
}

/** Translate one SDK event into zero or more backend-neutral updates. */
export function translateCopilotSdkEvent(
  sessionId: SessionId,
  event: CopilotSdkSessionEvent
): SessionEvent[] {
  switch (event.type) {
    case "assistant.message_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.data.deltaContent },
            messageId: event.data.messageId,
          },
        },
      ];
    case "assistant.reasoning_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.data.deltaContent },
            messageId: event.data.reasoningId,
          },
        },
      ];
    case "tool.execution_start":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.data.toolCallId,
            title: event.data.toolDescription?.description ?? event.data.toolName,
            kind: toolKind(event.data.toolName),
            status: "in_progress",
            rawInput: event.data.arguments,
            vendorToolName: event.data.toolName,
            mcpServer: event.data.mcpServerName,
          },
        },
      ];
    case "tool.execution_partial_result":
      return [
        toolUpdate(sessionId, event.data.toolCallId, "in_progress", event.data.partialOutput),
      ];
    case "tool.execution_progress":
      return [
        toolUpdate(sessionId, event.data.toolCallId, "in_progress", event.data.progressMessage),
      ];
    case "tool.execution_complete":
      return [
        toolUpdate(
          sessionId,
          event.data.toolCallId,
          event.data.success ? "completed" : "failed",
          event.data.error?.message ?? stringifyToolResult(event.data.result)
        ),
      ];
    case "session.error":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error: ${event.data.message}` },
          },
        },
      ];
    case "session.title_changed":
      return [
        {
          sessionId,
          update: { sessionUpdate: "session_info_update", title: event.data.title },
        },
      ];
    case "session.usage_info":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            usage: {
              usedTokens: event.data.currentTokens,
              contextWindow: event.data.tokenLimit,
              updatedAt: Date.now(),
            },
          },
        },
      ];
    case "assistant.usage":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            usage: {
              usedTokens: (event.data.inputTokens ?? 0) + (event.data.outputTokens ?? 0),
              inputTokens: event.data.inputTokens,
              outputTokens: event.data.outputTokens,
              cacheReadTokens: event.data.cacheReadTokens,
              cacheWriteTokens: event.data.cacheWriteTokens,
              updatedAt: Date.now(),
            },
          },
        },
      ];
    default:
      return [];
  }
}

function toolUpdate(
  sessionId: SessionId,
  toolCallId: string,
  status: "in_progress" | "completed" | "failed",
  text: string | null
): SessionEvent {
  const content: ToolCallContent[] | null = text
    ? [{ type: "content", content: { type: "text", text } }]
    : null;
  return {
    sessionId,
    update: { sessionUpdate: "tool_call_update", toolCallId, status, content },
  };
}

function stringifyToolResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function toolKind(name: string): ToolCallSnapshot["kind"] {
  const normalized = name.toLowerCase();
  if (/read|view/.test(normalized)) return "read";
  if (/edit|write|patch/.test(normalized)) return "edit";
  if (/delete|remove/.test(normalized)) return "delete";
  if (/move|rename/.test(normalized)) return "move";
  if (/search|grep|glob|find/.test(normalized)) return "search";
  if (/shell|bash|powershell|command|terminal/.test(normalized)) return "execute";
  if (/fetch|web|url/.test(normalized)) return "fetch";
  return "other";
}

/** Reconstruct the text-only display transcript from persisted SDK events. */
export function transcriptFromEvents(
  events: readonly CopilotSdkSessionEvent[]
): AgentChatMessage[] {
  const transcript: AgentChatMessage[] = [];
  for (const event of events) {
    if (event.type !== "user.message" && event.type !== "assistant.message") continue;
    const message = event.data.content;
    if (!message) continue;
    transcript.push({
      id: event.id,
      sender: event.type === "user.message" ? "user" : "assistant",
      timestamp: formatDateTime(new Date(event.timestamp)),
      isVisible: true,
      message,
    });
  }
  return transcript;
}
