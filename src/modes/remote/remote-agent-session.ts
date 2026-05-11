/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { type RpcAgentEventLike, translateRpcEvent } from "./event-translation.js"
import type { ReconnectSupervisor } from "./reconnect.js"
import type { RemoteRpcClient } from "./rpc-client.js"

export class RemoteAgentSession {
	private _rpcClient!: RemoteRpcClient
	private readonly _supervisor: ReconnectSupervisor
	private readonly _listeners = new Set<AgentSessionEventListener>()
	private _messages: Array<Record<string, unknown>> = []
	private _isStreaming = false
	private _steering: string[] = []
	private _followUp: string[] = []
	private _model?: Record<string, unknown>
	private _thinkingLevel = "disabled"
	private _unsubscribeEvent?: () => void

	constructor(options: {
		rpcClient: RemoteRpcClient
		supervisor: ReconnectSupervisor
		[key: string]: unknown
	}) {
		this._rpcClient = options.rpcClient
		this._supervisor = options.supervisor
		this._attachToClient(this._rpcClient)
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
		}

		const translated = translateRpcEvent(event)
		if (translated) this._emit(translated as AgentSessionEvent)
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
		return false
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
		return false
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
	bindExtensions() {
		return Promise.resolve()
	}
	reload() {
		return this._rpcClient.send("reload", {})
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
