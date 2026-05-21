import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { type RpcAgentEventLike, translateRpcEvent } from "../ws/events.js"
import type { ReconnectSupervisor } from "../ws/reconnect.js"
import type { RemoteRpcClient } from "../ws/rpc-client.js"
import { type SessionState, applyEvent, createInitialState } from "./agent-session-state.js"
import { type ExtensionBindings, bindExtensions } from "./extension-binding.js"
import { ExtensionUiBridge } from "./extension-ui-bridge.js"
import { persistMessage, syncMessagesToSessionManager } from "./message-persistence.js"

export class RemoteAgentSession {
	private _rpcClient!: RemoteRpcClient
	private readonly _supervisor: ReconnectSupervisor
	private readonly _sessionId: string
	private readonly _state: SessionState

	private readonly _settingsManager?: unknown
	private readonly _sessionManager?: unknown
	private readonly _resourceLoader?: unknown
	private readonly _modelRegistry?: unknown
	private readonly _extensionRunner?: unknown
	private readonly _uiBridge = new ExtensionUiBridge()
	private readonly _listeners = new Set<AgentSessionEventListener>()
	private _cachedContextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null }
	private _pollTimer?: ReturnType<typeof setInterval>
	private readonly _pollIntervalMs = 30_000
	private _unsubscribeEvent?: () => void

	constructor(options: {
		rpcClient: RemoteRpcClient
		supervisor: ReconnectSupervisor
		sessionId: string
		settingsManager?: unknown
		sessionManager?: unknown
		resourceLoader?: unknown
		modelRegistry?: unknown
		extensionRunner?: unknown
		[key: string]: unknown
	}) {
		this._rpcClient = options.rpcClient
		this._supervisor = options.supervisor
		this._sessionId = options.sessionId
		this._state = createInitialState()
		this._settingsManager = options.settingsManager
		this._sessionManager = options.sessionManager
		this._resourceLoader = options.resourceLoader
		this._modelRegistry = options.modelRegistry
		this._extensionRunner = options.extensionRunner
		this._attachToClient(this._rpcClient)
		this._startContextUsagePolling()
	}

	// ─── Public getters (duck-typed for InteractiveMode) ───

	get sessionId(): string {
		return this._sessionId
	}
	get settingsManager() {
		return this._settingsManager
	}
	get sessionManager() {
		return this._sessionManager
	}
	get resourceLoader() {
		return this._resourceLoader
	}
	get modelRegistry() {
		return this._modelRegistry
	}
	get extensionRunner() {
		return this._extensionRunner
	}
	get state() {
		return {
			messages: this._state.messages,
			turnIndex: 0,
			aborted: false,
			loopType: "chat",
			toolCallCount: 0,
			isStreaming: this._state.isStreaming,
		}
	}
	get agent() {
		return {
			state: this.state,
			abort: () => {
				void this.abort()
			},
			signal: new AbortController().signal,
		}
	}
	get isStreaming() {
		return this._state.isStreaming
	}
	// Exposed for extension-binding.ts adapter
	get _isStreaming() {
		return this._state.isStreaming
	}
	get messages() {
		return this._state.messages
	}
	get systemPrompt() {
		return ""
	}
	get retryAttempt() {
		return 0
	}
	get isCompacting() {
		return this._state.isCompacting
	}
	get model() {
		return this._state.model
	}
	// Exposed for extension-binding.ts adapter
	get _model() {
		return this._state.model
	}
	get thinkingLevel() {
		return this._state.thinkingLevel
	}
	// Exposed for extension-binding.ts adapter
	get _thinkingLevel() {
		return this._state.thinkingLevel
	}
	get sessionFile() {
		return undefined
	}
	get sessionName() {
		return undefined
	}
	get scopedModels() {
		return []
	}
	get promptTemplates() {
		return []
	}
	get pendingMessageCount() {
		return this._state.steering.length + this._state.followUp.length
	}
	get isBashRunning() {
		return this._state.isBashRunning
	}
	get hasPendingBashMessages() {
		return false
	}
	get isRetrying() {
		return this._state.isRetrying
	}
	get autoRetryEnabled() {
		return false
	}
	get autoCompactionEnabled() {
		return false
	}
	get contextUsage() {
		return undefined
	}
	get steeringMode() {
		return "manual"
	}
	get followUpMode() {
		return "manual"
	}

	// ─── Event subscription ───

	subscribe(listener: AgentSessionEventListener): () => void {
		this._listeners.add(listener)
		return () => this._listeners.delete(listener)
	}

	dispose() {
		this._listeners.clear()
		this._unsubscribeEvent?.()
		this._supervisor.dispose()
		if (this._pollTimer) {
			clearInterval(this._pollTimer)
			this._pollTimer = undefined
		}
	}

	// ─── RPC methods ───

	prompt(text: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("prompt", { message: text, ...options })
	}
	steer(text: string) {
		this._state.steering.push(text)
		return this._rpcClient.send("steer", { message: text })
	}
	followUp(text: string) {
		this._state.followUp.push(text)
		return this._rpcClient.send("follow_up", { message: text })
	}
	abort() {
		return this._rpcClient.send("abort", {})
	}
	setModel(model: Record<string, string>) {
		this._state.model = model
		return this._rpcClient.send("set_model", { provider: model.provider, modelId: model.id })
	}
	cycleModel(direction?: string) {
		return this._rpcClient.send("cycle_model", { direction })
	}
	setThinkingLevel(level: string) {
		this._state.thinkingLevel = level
		return this._rpcClient.send("set_thinking_level", { level })
	}
	setSteeringMode(mode: string) {
		return this._rpcClient.send("set_steering_mode", { mode })
	}
	setFollowUpMode(mode: string) {
		return this._rpcClient.send("set_follow_up_mode", { mode })
	}
	setPermissionMode(mode: string) {
		return this._rpcClient.send("prompt", { message: `/permissions mode ${mode}` })
	}
	compact(customInstructions?: string) {
		return this._rpcClient.send("compact", { customInstructions })
	}
	abortCompaction() {
		return this._rpcClient.send("abort_compaction", {})
	}
	setAutoCompactionEnabled(enabled: boolean) {
		return this._rpcClient.send("set_auto_compaction", { enabled })
	}
	abortRetry() {
		return this._rpcClient.send("abort_retry", {})
	}
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		_options?: { excludeFromContext?: boolean; operations?: unknown },
	) {
		return this._rpcClient.send("bash", { command }).then((data: unknown) => {
			if (data && typeof data === "object") {
				const result = data as { output?: unknown; exitCode?: unknown; cancelled?: unknown }
				if (typeof result.output === "string" && onChunk) {
					onChunk(result.output)
				}
				return data
			}
			return { output: "", exitCode: 0, cancelled: false }
		})
	}
	abortBash() {
		return this._rpcClient.send("abort_bash", {})
	}
	setSessionName(name: string) {
		return this._rpcClient.send("set_session_name", { name })
	}
	exportToHtml(outputPath?: string) {
		return this._rpcClient.send("export_html", { outputPath })
	}
	exportToJsonl() {
		return ""
	}
	getLastAssistantText() {
		return this._rpcClient.send("get_last_assistant_text", {})
	}
	switchSession(sessionPath: string) {
		return this._rpcClient.send("switch_session", { sessionPath })
	}
	getState() {
		return this._rpcClient.send("get_state", {})
	}
	reload() {
		return this._rpcClient.send("reload", {})
	}
	cycleThinkingLevel(direction?: string) {
		return this._rpcClient.send("cycle_thinking_level", { direction })
	}
	setScopedModels(models: unknown[]) {
		return this._rpcClient.send("set_scoped_models", { models })
	}
	abortBranchSummary() {
		return this._rpcClient.send("abort_branch_summary", {})
	}
	sendCustomMessage(message: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("send_custom_message", { message, options })
	}
	sendUserMessage(content: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("send_user_message", { content, options })
	}
	navigateTree() {
		return Promise.reject(new Error("navigateTree is not supported in remote mode"))
	}
	getActiveToolNames() {
		return []
	}
	getAllTools() {
		return []
	}
	getToolDefinition(_name: string) {
		return undefined
	}
	setActiveToolsByName() {
		/* no-op */
	}
	getUserMessagesForForking(): Array<Record<string, unknown>> {
		return []
	}

	// ─── Queue management ───

	clearQueue() {
		const s = [...this._state.steering]
		const f = [...this._state.followUp]
		this._state.steering = []
		this._state.followUp = []
		return { steering: s, followUp: f }
	}
	getSteeringMessages() {
		return [...this._state.steering]
	}
	getFollowUpMessages() {
		return [...this._state.followUp]
	}

	// ─── Session stats ───

	getSessionStats() {
		let toolCalls = 0
		for (const msg of this._state.messages) {
			if (msg.role === "assistant") {
				const content = msg.content
				if (Array.isArray(content)) {
					toolCalls += content.filter((c) => (c as { type?: string })?.type === "toolCall").length
				}
			}
		}
		return {
			sessionFile: undefined,
			sessionId: this._sessionId,
			userMessages: this._state.messages.filter((m) => m.role === "user").length,
			assistantMessages: this._state.messages.filter((m) => m.role === "assistant").length,
			toolCalls,
			toolResults: this._state.messages.filter((m) => m.role === "toolResult").length,
			totalMessages: this._state.messages.length,
			tokens: {
				input: this._state.totalInput,
				output: this._state.totalOutput,
				cacheRead: this._state.totalCacheRead,
				cacheWrite: this._state.totalCacheWrite,
				total:
					this._state.totalInput + this._state.totalOutput + this._state.totalCacheRead + this._state.totalCacheWrite,
			},
			cost: 0,
			contextUsage: this._cachedContextUsage
				? {
						percent: this._cachedContextUsage.percent,
						tokens: this._cachedContextUsage.tokens,
						contextWindow: this._cachedContextUsage.contextWindow,
					}
				: undefined,
		}
	}

	getContextUsage() {
		if (!this._cachedContextUsage || this._cachedContextUsage.percent == null) return undefined
		return {
			tokens: this._cachedContextUsage.tokens,
			contextWindow: this._cachedContextUsage.contextWindow,
			percent: this._cachedContextUsage.percent,
		}
	}

	getAvailableThinkingLevels(): string[] {
		return ["disabled", "low", "medium", "high"]
	}

	getMessages() {
		return this._rpcClient.send("get_messages", {}).then((res: unknown) => {
			const maybe = res as { messages?: Array<Record<string, unknown>> }
			if (maybe?.messages) {
				this._state.messages = maybe.messages
				syncMessagesToSessionManager(this._sessionManager, maybe.messages)
			}
			return maybe
		})
	}

	recordBashResult(result: unknown) {
		const bashMessage = {
			role: "bashExecution",
			...(result as Record<string, unknown>),
			timestamp: Date.now(),
		}
		persistMessage(this._sessionManager, bashMessage)
	}

	// ─── Extension binding (delegates to extracted module) ───

	async bindExtensions(bindings?: ExtensionBindings) {
		await bindExtensions(
			this,
			this._uiBridge,
			this._extensionRunner,
			this._sessionManager,
			this._modelRegistry,
			bindings,
		)
	}

	// ─── Reconnect support ───

	swapRpcClient(client: RemoteRpcClient) {
		this._rpcClient = client
		this._attachToClient(client)
		this._rpcClient
			.send("get_messages", {})
			.then((res: unknown) => {
				const maybe = res as { messages?: Array<Record<string, unknown>> }
				if (maybe?.messages) {
					this._state.messages = maybe.messages
					syncMessagesToSessionManager(this._sessionManager, maybe.messages)
				}
			})
			.catch(() => {})
	}

	// ─── Internal ───

	private _attachToClient(client: RemoteRpcClient) {
		this._unsubscribeEvent?.()
		this._unsubscribeEvent = client.onEvent((event) => {
			this._handleEvent(event as unknown as RpcAgentEventLike)
		})
	}

	private _handleEvent(event: RpcAgentEventLike) {
		if (event.type === "extension_ui_request") {
			void this._uiBridge.handle(event, this._rpcClient)
			return
		}

		const { newMessage } = applyEvent(this._state, event)
		if (newMessage) {
			persistMessage(this._sessionManager, newMessage)
		}

		// Forward to local extension runner
		const runner = this._extensionRunner as { emit?: (e: unknown) => Promise<unknown> } | undefined
		if (runner?.emit) {
			void runner.emit(event).catch(() => {})
		}

		const translated = translateRpcEvent(event)
		if (translated) {
			for (const listener of this._listeners) {
				try {
					listener(translated as AgentSessionEvent)
				} catch {
					/* swallow */
				}
			}
		}
	}

	private _startContextUsagePolling(): void {
		void this._refreshContextUsage()
		this._pollTimer = setInterval(() => {
			void this._refreshContextUsage()
		}, this._pollIntervalMs)
	}

	private async _refreshContextUsage(): Promise<void> {
		try {
			const stats = (await this._rpcClient.send("get_session_stats", {})) as {
				contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null }
			}
			if (stats?.contextUsage) {
				this._cachedContextUsage = stats.contextUsage
			}
		} catch {
			// Keep previous cached value on failure.
		}
	}
}
