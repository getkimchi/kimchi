/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentSessionEvent, AgentSessionEventListener, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { type RpcAgentEventLike, translateRpcEvent } from "./event-translation.js"
import type { ReconnectSupervisor } from "./reconnect.js"
import type { RemoteRpcClient } from "./rpc-client.js"

export class RemoteAgentSession {
	private _rpcClient!: RemoteRpcClient
	private readonly _supervisor: ReconnectSupervisor
	private readonly _sessionId: string
	private readonly _settingsManager?: unknown
	private readonly _sessionManager?: unknown
	private readonly _resourceLoader?: unknown
	private readonly _modelRegistry?: unknown
	private readonly _extensionRunner?: unknown
	private _uiContext?: ExtensionUIContext
	private readonly _listeners = new Set<AgentSessionEventListener>()
	private _messages: Array<Record<string, unknown>> = []
	private _isStreaming = false
	private _steering: string[] = []
	private _followUp: string[] = []
	private _model?: Record<string, unknown>
	private _thinkingLevel = "disabled"
	private _isCompacting = false
	private _isRetrying = false
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
		this._settingsManager = options.settingsManager
		this._sessionManager = options.sessionManager
		this._resourceLoader = options.resourceLoader
		this._modelRegistry = options.modelRegistry
		this._extensionRunner = options.extensionRunner
		this._attachToClient(this._rpcClient)
	}

	/**
	 * The remote session id this client is connected to. Surfaced so the
	 * `TeleportableAgentSession` wrapper can key its detached map and emit
	 * `transport_changed` events without reaching into RPC-shaped state.
	 */
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

	private _attachToClient(client: RemoteRpcClient) {
		this._unsubscribeEvent?.()
		this._unsubscribeEvent = client.onEvent((event) => {
			// RpcEventListener's parameter is the pi-mono `AgentEvent` union;
			// we work with a structural superset (`RpcAgentEventLike`) here so
			// the switch can compile without exhaustive-case fights when the
			// server adds new event kinds.
			this._handleEvent(event as unknown as RpcAgentEventLike)
		})
	}

	private _handleEvent(event: RpcAgentEventLike) {
		switch (event.type) {
			case "agent_start":
				this._isStreaming = true
				this._steering = []
				this._followUp = []
				break
			case "agent_end":
				this._isStreaming = false
				if (event.messages) {
					this._messages = event.messages as Array<Record<string, unknown>>
				}
				break
			case "message_end":
				if (event.message) {
					this._messages = [...this._messages, event.message as Record<string, unknown>]
				}
				break
			case "model_selected":
				this._model = {
					id: event.modelId,
					provider: event.provider,
				}
				break
			case "thinking_level_changed":
				this._thinkingLevel = (event.level as string) ?? "disabled"
				break
			case "compaction_start":
				this._isCompacting = true
				break
			case "compaction_end":
				this._isCompacting = false
				break
			case "auto_retry_start":
				this._isRetrying = true
				break
			case "auto_retry_end":
				this._isRetrying = false
				break
			case "extension_ui_request":
				void this._handleExtensionUiRequest(event)
				return
		}

		// Replay server-side agent events into the local extension runner so
		// client-side extensions (which all kimchi extensions are — same code
		// loaded on both sides) see turn_start / message_end / tool_execution_*
		// / queue_update / compaction_* / auto_retry_* / etc.  runner.emit is a
		// string-keyed dispatch: unhandled event types are silent no-ops.
		this._forwardToExtensionRunner(event)

		const translated = translateRpcEvent(event)
		if (translated) this._emit(translated as AgentSessionEvent)
	}

	private _forwardToExtensionRunner(event: RpcAgentEventLike) {
		const runner = this._extensionRunner as { emit?: (e: unknown) => Promise<unknown> } | undefined
		if (!runner?.emit) return
		void runner.emit(event).catch(() => {
			// Swallow — extension errors flow through extension_error events.
		})
	}

	private async _handleExtensionUiRequest(event: RpcAgentEventLike) {
		const id = event.id as string | undefined
		const method = event.method as string | undefined
		const ui = this._uiContext
		const sendResponse = (resp: Record<string, unknown>) => {
			if (!id) return
			void this._rpcClient.sendOneWay({ type: "extension_ui_response", id, ...resp })
		}
		if (!ui) {
			// No UI bound yet — cancel so the server doesn't hang.
			sendResponse({ cancelled: true })
			return
		}
		try {
			switch (method) {
				case "select": {
					const value = await ui.select?.(event.title as string, event.options as string[], {
						timeout: event.timeout as number | undefined,
					})
					sendResponse(value === undefined ? { cancelled: true } : { value })
					break
				}
				case "confirm": {
					const confirmed = await ui.confirm?.(event.title as string, event.message as string, {
						timeout: event.timeout as number | undefined,
					})
					sendResponse(confirmed === undefined ? { cancelled: true } : { confirmed })
					break
				}
				case "input": {
					const value = await ui.input?.(event.title as string, event.placeholder as string | undefined, {
						timeout: event.timeout as number | undefined,
					})
					sendResponse(value === undefined ? { cancelled: true } : { value })
					break
				}
				case "editor": {
					const value = await ui.editor?.(event.title as string, event.prefill as string | undefined)
					sendResponse(value === undefined ? { cancelled: true } : { value })
					break
				}
				case "notify":
					ui.notify?.(event.message as string, event.notifyType as "warning" | "error" | "info" | undefined)
					break
				case "setStatus":
					ui.setStatus?.(event.statusKey as string, event.statusText as string | undefined)
					break
				case "setTitle":
					ui.setTitle?.(event.title as string)
					break
				case "setWidget":
					ui.setWidget?.(event.widgetKey as string, event.widgetLines as string[] | undefined, {
						placement: event.widgetPlacement as "aboveEditor" | "belowEditor" | undefined,
					})
					break
				case "set_editor_text":
					ui.setEditorText?.(event.text as string)
					break
				default:
					// Unknown method: log so we notice new server-side ui calls,
					// and cancel any request/response shape so the server doesn't hang.
					console.error(`kimchi: unhandled extension_ui_request method "${method}"`)
					if (id) sendResponse({ cancelled: true })
			}
		} catch {
			if (id) sendResponse({ cancelled: true })
		}
	}

	private _emit(event: AgentSessionEvent) {
		for (const listener of this._listeners) {
			try {
				listener(event)
			} catch {
				/* swallow */
			}
		}
	}

	// Duck-typed getters that InteractiveMode reads
	get state() {
		return {
			messages: this._messages,
			turnIndex: 0,
			aborted: false,
			loopType: "chat",
			toolCallCount: 0,
			isStreaming: this._isStreaming,
		}
	}
	get agent() {
		return {
			state: {
				messages: this._messages,
				turnIndex: 0,
				aborted: false,
				loopType: "chat",
				toolCallCount: 0,
				isStreaming: this._isStreaming,
			},
			abort: () => {},
		}
	}
	get isStreaming() {
		return this._isStreaming
	}
	get messages() {
		return this._messages
	}
	get systemPrompt() {
		return ""
	}
	get retryAttempt() {
		return 0
	}
	get isCompacting() {
		return this._isCompacting
	}
	get model() {
		return this._model
	}
	get thinkingLevel() {
		return this._thinkingLevel
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
		return this._steering.length + this._followUp.length
	}
	get isBashRunning() {
		return false
	}
	get hasPendingBashMessages() {
		return false
	}
	get isRetrying() {
		return this._isRetrying
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

	// Used by InteractiveMode to bind events
	subscribe(listener: AgentSessionEventListener): () => void {
		this._listeners.add(listener)
		return () => this._listeners.delete(listener)
	}

	dispose() {
		this._listeners.clear()
		this._unsubscribeEvent?.()
		this._supervisor.dispose()
	}

	// ─── Methods forwarded to RPC client ───
	prompt(text: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("prompt", {
			message: text,
			...options,
		})
	}
	steer(text: string) {
		this._steering.push(text)
		return this._rpcClient.send("steer", { message: text })
	}
	followUp(text: string) {
		this._followUp.push(text)
		return this._rpcClient.send("follow_up", { message: text })
	}
	abort() {
		return this._rpcClient.send("abort", {})
	}
	setModel(model: Record<string, string>) {
		this._model = model
		return this._rpcClient.send("set_model", {
			provider: model.provider,
			modelId: model.id,
		})
	}
	cycleModel(direction?: string) {
		return this._rpcClient.send("cycle_model", { direction })
	}
	setThinkingLevel(level: string) {
		this._thinkingLevel = level
		return this._rpcClient.send("set_thinking_level", { level })
	}
	setSteeringMode(mode: string) {
		return this._rpcClient.send("set_steering_mode", { mode })
	}
	setFollowUpMode(mode: string) {
		return this._rpcClient.send("set_follow_up_mode", { mode })
	}
	setPermissionMode(mode: string) {
		// Server has no dedicated RPC verb for this - but the permissions
		// extension already registers a /permissions slash command, and the
		// server's `prompt` handler dispatches `/`-prefixed messages straight
		// to extension handlers (executes immediately, no LLM round-trip).
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
	executeBash(command: string) {
		return this._rpcClient.send("bash", { command })
	}
	abortBash() {
		return this._rpcClient.send("abort_bash", {})
	}
	setSessionName(name: string) {
		return this._rpcClient.send("set_session_name", { name })
	}
	getSessionStats() {
		return this._rpcClient.send("get_session_stats", {})
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
	clearQueue() {
		const s = [...this._steering]
		const f = [...this._followUp]
		this._steering = []
		this._followUp = []
		return { steering: s, followUp: f }
	}
	getSteeringMessages() {
		return [...this._steering]
	}
	getFollowUpMessages() {
		return [...this._followUp]
	}

	/**
	 * Ask the remote server to switch to a different session file.
	 * Used after teleporting with `--with-session` to load the rsynced
	 * session export.
	 */
	switchSession(sessionPath: string) {
		return this._rpcClient.send("switch_session", { sessionPath })
	}

	/**
	 * Fetch the current messages array from the remote session and sync our
	 * local cache. Useful after `switchSession` to refresh client state.
	 */
	getMessages() {
		return this._rpcClient.send("get_messages", {}).then((res: unknown) => {
			const maybe = res as { messages?: Array<Record<string, unknown>> }
			if (maybe?.messages) {
				this._messages = maybe.messages
			}
			return maybe
		})
	}

	/**
	 * Fetch the current remote session state (model, thinking level, …).
	 * Useful after `switchSession` to sync local client state.
	 */
	getState() {
		return this._rpcClient.send("get_state", {})
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
	async bindExtensions(bindings?: {
		uiContext?: unknown
		commandContextActions?: unknown
		shutdownHandler?: unknown
		onError?: (error: unknown) => void
	}) {
		const runner = this._extensionRunner as
			| {
					setUIContext?: (ctx: unknown) => void
					bindCommandContext?: (actions: unknown) => void
					bindCore?: (actions: unknown, contextActions: unknown, providerActions?: unknown) => void
					onError?: (cb: (e: unknown) => void) => () => void
					emit?: (event: unknown) => Promise<unknown>
			  }
			| undefined
		if (!runner) return

		// Replace the loader-time "not initialized" stubs with real actions
		// before any extension's session_start handler runs.
		const sessionManager = this._sessionManager as
			| {
					appendCustomEntry?: (type: string, data: unknown) => void
					getSessionName?: () => string | undefined
					appendLabelChange?: (entryId: string, label: string) => void
			  }
			| undefined
		const modelRegistry = this._modelRegistry as
			| {
					registerProvider?: (name: string, config: unknown) => void
					unregisterProvider?: (name: string) => void
			  }
			| undefined
		runner.bindCore?.(
			{
				sendMessage: (message: string, options?: Record<string, unknown>) => {
					this.sendCustomMessage(message, options).catch(() => {})
				},
				sendUserMessage: (content: string, options?: Record<string, unknown>) => {
					this.sendUserMessage(content, options).catch(() => {})
				},
				appendEntry: (customType: string, data: unknown) => {
					sessionManager?.appendCustomEntry?.(customType, data)
				},
				setSessionName: (name: string) => {
					void this.setSessionName(name)
				},
				getSessionName: () => sessionManager?.getSessionName?.(),
				setLabel: (entryId: string, label: string) => {
					sessionManager?.appendLabelChange?.(entryId, label)
				},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: () => {},
				refreshTools: () => {},
				getCommands: () => [],
				setModel: async (model: Record<string, string>) => {
					await this.setModel(model)
					return true
				},
				getThinkingLevel: () => this._thinkingLevel,
				setThinkingLevel: (level: string) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this._model,
				isIdle: () => !this._isStreaming,
				getSignal: () => new AbortController().signal,
				abort: () => {
					void this.abort()
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					bindings?.shutdownHandler && (bindings.shutdownHandler as () => void)()
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options?: {
					customInstructions?: string
					onComplete?: (r: unknown) => void
					onError?: (e: Error) => void
				}) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions)
							options?.onComplete?.(result)
						} catch (err) {
							options?.onError?.(err instanceof Error ? err : new Error(String(err)))
						}
					})()
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name: string, config: unknown) => {
					modelRegistry?.registerProvider?.(name, config)
				},
				unregisterProvider: (name: string) => {
					modelRegistry?.unregisterProvider?.(name)
				},
			},
		)

		this._uiContext = bindings?.uiContext as ExtensionUIContext | undefined
		runner.setUIContext?.(bindings?.uiContext)
		runner.bindCommandContext?.(bindings?.commandContextActions)
		if (bindings?.onError) runner.onError?.(bindings.onError)
		await runner.emit?.({ type: "session_start", reason: "startup" })
	}
	reload() {
		return this._rpcClient.send("reload", {})
	}
	getContextUsage() {
		return undefined
	}
	getAvailableThinkingLevels(): string[] {
		return ["disabled", "low", "medium", "high"]
	}
	cycleThinkingLevel(direction?: string) {
		return this._rpcClient.send("cycle_thinking_level", { direction })
	}
	getUserMessagesForForking(): Array<Record<string, unknown>> {
		return []
	}
	setScopedModels(models: unknown[]) {
		return this._rpcClient.send("set_scoped_models", { models })
	}
	recordBashResult(_result: unknown) {
		/* no-op — bash commands stream results via events */
	}
	abortBranchSummary() {
		return this._rpcClient.send("abort_branch_summary", {})
	}
	sendCustomMessage(message: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("send_custom_message", {
			message,
			options,
		})
	}
	sendUserMessage(content: string, options?: Record<string, unknown>) {
		return this._rpcClient.send("send_user_message", {
			content,
			options,
		})
	}

	// Reconnect support
	swapRpcClient(client: RemoteRpcClient) {
		this._rpcClient = client
		this._attachToClient(client)
		// Re-sync state from server
		this._rpcClient
			.send("get_messages", {})
			.then((res: unknown) => {
				const maybe = res as {
					messages?: Array<Record<string, unknown>>
				}
				if (maybe?.messages) {
					this._messages = maybe.messages
				}
			})
			.catch(() => {})
	}
}
