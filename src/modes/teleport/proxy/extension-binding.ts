import type { ExtensionUiBridge } from "./extension-ui-bridge.js"

interface BindableSession {
	readonly pendingMessageCount: number
	readonly systemPrompt: string
	readonly _thinkingLevel: string
	readonly _model?: Record<string, unknown>
	readonly _isStreaming: boolean
	setModel(model: Record<string, string>): Promise<unknown>
	setThinkingLevel(level: string): Promise<unknown>
	setSessionName(name: string): Promise<unknown>
	abort(): Promise<unknown>
	compact(customInstructions?: string): Promise<unknown>
	sendCustomMessage(message: string, options?: Record<string, unknown>): Promise<unknown>
	sendUserMessage(content: string, options?: Record<string, unknown>): Promise<unknown>
	getContextUsage(): unknown
}

export interface ExtensionBindings {
	uiContext?: unknown
	commandContextActions?: unknown
	shutdownHandler?: unknown
	onError?: (error: unknown) => void
}

/**
 * Wire a local ExtensionRunner to a remote session by building the adapter
 * objects that `runner.bindCore` expects.
 *
 * Extracted from RemoteAgentSession.bindExtensions so the core class stays
 * focused on RPC forwarding and state management.
 */
export async function bindExtensions(
	session: BindableSession,
	uiBridge: ExtensionUiBridge,
	extensionRunner: unknown,
	sessionManager: unknown,
	modelRegistry: unknown,
	bindings?: ExtensionBindings,
): Promise<void> {
	uiBridge.bind(bindings?.uiContext as import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined)

	const runner = extensionRunner as
		| {
				setUIContext?: (ctx: unknown) => void
				bindCommandContext?: (actions: unknown) => void
				bindCore?: (actions: unknown, contextActions: unknown, providerActions?: unknown) => void
				onError?: (cb: (e: unknown) => void) => () => void
				emit?: (event: unknown) => Promise<unknown>
		  }
		| undefined
	if (!runner) return

	const sm = sessionManager as
		| {
				appendCustomEntry?: (type: string, data: unknown) => void
				getSessionName?: () => string | undefined
				appendLabelChange?: (entryId: string, label: string) => void
		  }
		| undefined

	const mr = modelRegistry as
		| {
				registerProvider?: (name: string, config: unknown) => void
				unregisterProvider?: (name: string) => void
		  }
		| undefined

	runner.bindCore?.(
		{
			sendMessage: (message: string, options?: Record<string, unknown>) => {
				session.sendCustomMessage(message, options).catch(() => {})
			},
			sendUserMessage: (content: string, options?: Record<string, unknown>) => {
				session.sendUserMessage(content, options).catch(() => {})
			},
			appendEntry: (customType: string, data: unknown) => {
				sm?.appendCustomEntry?.(customType, data)
			},
			setSessionName: (name: string) => {
				void session.setSessionName(name)
			},
			getSessionName: () => sm?.getSessionName?.(),
			setLabel: (entryId: string, label: string) => {
				sm?.appendLabelChange?.(entryId, label)
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async (model: Record<string, string>) => {
				await session.setModel(model)
				return true
			},
			getThinkingLevel: () => session._thinkingLevel,
			setThinkingLevel: (level: string) => session.setThinkingLevel(level),
		},
		{
			getModel: () => session._model,
			isIdle: () => !session._isStreaming,
			getSignal: () => new AbortController().signal,
			abort: () => {
				void session.abort()
			},
			hasPendingMessages: () => session.pendingMessageCount > 0,
			shutdown: () => {
				bindings?.shutdownHandler && (bindings.shutdownHandler as () => void)()
			},
			getContextUsage: () => session.getContextUsage(),
			compact: (options?: {
				customInstructions?: string
				onComplete?: (r: unknown) => void
				onError?: (e: Error) => void
			}) => {
				void (async () => {
					try {
						const result = await session.compact(options?.customInstructions)
						options?.onComplete?.(result)
					} catch (err) {
						options?.onError?.(err instanceof Error ? err : new Error(String(err)))
					}
				})()
			},
			getSystemPrompt: () => session.systemPrompt,
		},
		{
			registerProvider: (name: string, config: unknown) => {
				mr?.registerProvider?.(name, config)
			},
			unregisterProvider: (name: string) => {
				mr?.unregisterProvider?.(name)
			},
		},
	)

	runner.setUIContext?.(bindings?.uiContext)
	runner.bindCommandContext?.(bindings?.commandContextActions)
	if (bindings?.onError) runner.onError?.(bindings.onError)
	await runner.emit?.({ type: "session_start", reason: "startup" })
}
