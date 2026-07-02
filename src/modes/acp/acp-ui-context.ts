// ACP-side ExtensionUIContext. pi routes every `ctx.ui.*` call from extensions
// through whatever object was last passed to
// `session.bindExtensions({ uiContext, mode })`.
//
// `setTitle` deliberately uses ACP-native `session_info_update` instead of the
// extension namespace — every ACP client renders it without a custom handler.
//
// When a method isn't supported by the client, `warnUnsupportedMethod` emits
// one `agent_message_chunk` per (method, session) so the user sees the dropped
// call instead of getting a method-not-found round-trip. Dedup matters because
// extensions probe `setStatus`/`setWidget` on every model token.

import { randomUUID } from "node:crypto"
import type {
	AgentSideConnection,
	ClientCapabilities,
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationAcceptAction,
	ElicitationSchema,
	PermissionOption,
	RequestPermissionOutcome,
	RequestPermissionRequest,
	SessionNotification,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { ExtensionUIContext, Theme as ThemeType } from "@earendil-works/pi-coding-agent"
import {
	AVAILABLE_METHODS,
	type PiMethod,
	getClientSupportsElicitation,
	getClientSupportsMethod,
} from "./capabilities.js"
import { requestWithAbort } from "./utils.js"

type DialogResponse = {
	value?: string | boolean
	confirmed?: boolean
	cancelled?: boolean
}

const REQUEST_TYPE = "extension_ui_request"

const NOOP_THEME = createNoopTheme()

/**
 * Build an `ExtensionUIContext` that proxies all interaction through the ACP
 * connection. Bound to a single session — do not share across sessions.
 *
 * Dialog errors (method-not-supported, transport failure, bad shape) resolve
 * to the default TUI value instead of rejecting — matches pi's interactive
 * semantics where a closed/dismissed dialog never throws.
 */
export function createAcpUIContext(
	conn: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
	send: (params: SessionNotification) => void,
): ExtensionUIContext {
	const supportsElicitation = getClientSupportsElicitation(clientCapabilities)
	const supportsMethod = (method: PiMethod) => getClientSupportsMethod(clientCapabilities, method)

	async function requestDialog<T extends DialogResponse>(
		acpMethod: "pi_editor",
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<T | "aborted"> {
		try {
			return await requestWithAbort(
				conn.extMethod(AVAILABLE_METHODS[acpMethod], {
					type: REQUEST_TYPE,
					id: randomUUID(),
					sessionId,
					...payload,
				}) as Promise<T>,
				signal,
			)
		} catch (err) {
			logError(AVAILABLE_METHODS[acpMethod], err)
			return { cancelled: true } as T
		}
	}

	function notify(
		payload: Record<string, unknown> & {
			method: "notify" | "setStatus" | "setWidget" | "set_editor_text"
		},
	): void {
		const acpMethod = AVAILABLE_METHODS.pi_notify
		conn
			.extNotification(acpMethod, {
				type: REQUEST_TYPE,
				id: randomUUID(),
				sessionId,
				...payload,
			})
			.catch((err) => logError(acpMethod, err))
	}

	// One warning per method per session — extensions probe setStatus/setWidget
	// on every model token and we don't want to spam agent_message_chunk.
	const unsupportedMethodsWarned = new Set<string>()

	function warnUnsupportedMethod(method: string, summary: string): void {
		if (unsupportedMethodsWarned.has(method)) return
		unsupportedMethodsWarned.add(method)
		send({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `[ACP] ${method}: ${summary}` },
			},
		})
	}

	// Returns the content on `accept`, undefined on `decline`/`cancel`,
	// `"aborted"` if the caller's signal fires or the transport rejects.
	async function elicitForm(
		title: string,
		message: string | undefined,
		requestedSchema: ElicitationSchema,
		signal: AbortSignal | undefined,
	): Promise<NonNullable<ElicitationAcceptAction["content"]> | "aborted" | undefined> {
		const params: CreateElicitationRequest = {
			requestId: randomUUID(),
			sessionId,
			mode: "form" as const,
			message: message ? `${title}: ${message}` : title,
			requestedSchema,
		}
		try {
			const response = await requestWithAbort<CreateElicitationResponse>(
				conn.unstable_createElicitation(params),
				signal,
			)
			if (response === "aborted") {
				throw Error("aborted")
			}
			if (response.action !== "accept") return undefined
			return response.content ?? undefined
		} catch (err) {
			logError("elicitation/create", err)
			return "aborted"
		}
	}

	// `request_permission` is tool-call-coupled, so we wrap the choice in a
	// synthetic ToolCallUpdate — the client renders it as a permission dialog
	// with the options we provide.
	async function requestPermissionFallback(
		kind: "confirm" | "select",
		title: string,
		message: string | undefined,
		options: PermissionOption[],
		signal: AbortSignal | undefined,
	): Promise<RequestPermissionOutcome> {
		const toolCall: ToolCallUpdate = {
			toolCallId: `pi-ui-${kind}-${randomUUID()}`,
			title,
			kind: "other",
			status: "pending",
			rawInput: message !== undefined ? { message } : undefined,
		}
		const params: RequestPermissionRequest = {
			sessionId,
			toolCall,
			options,
		}
		try {
			const response = await requestWithAbort(conn.requestPermission(params), signal)
			if (response === "aborted" || response.outcome.outcome === "cancelled") {
				return { outcome: "cancelled" }
			}
			return { outcome: "selected", optionId: response.outcome.optionId }
		} catch (err) {
			logError(`request_permission(${kind})`, err)
			return { outcome: "cancelled" }
		}
	}

	const ui: ExtensionUIContext = {
		async select(title, options, opts) {
			if (options.length === 0) return undefined

			if (supportsElicitation) {
				const schema: ElicitationSchema = {
					type: "object",
					properties: {
						value: {
							type: "string",
							oneOf: options.map((opt) => ({ const: opt, title: opt })),
						},
					},
					required: ["value"],
				}
				const response = await elicitForm(title, undefined, schema, opts?.signal)
				if (response === "aborted" || response === undefined) return undefined
				const value = response.value
				return typeof value === "string" ? value : undefined
			}

			const result = await requestPermissionFallback(
				"select",
				title,
				undefined,
				options.map((name, i) => ({
					optionId: `choice-${i}`,
					name,
					kind: "allow_once",
				})),
				opts?.signal,
			)
			if (result.outcome !== "selected") return undefined
			const idx = Number.parseInt(result.optionId?.replace("choice-", "") ?? "", 10)
			return Number.isFinite(idx) ? options[idx] : undefined
		},

		async confirm(title, message, opts) {
			if (supportsElicitation) {
				const schema: ElicitationSchema = {
					type: "object",
					properties: {
						confirmed: {
							type: "boolean",
							// Default is always false as Pi has no way of distinguishing
							// a confirm result as cancelled (e.g. user didn't select explicitly)
							default: false,
						},
					},
					required: ["confirmed"],
				}
				const response = await elicitForm(title, message, schema, opts?.signal)
				if (response === "aborted" || response === undefined) return false
				return response.confirmed === true
			}

			const result = await requestPermissionFallback(
				"confirm",
				title,
				message,
				[
					{ optionId: "yes", name: "Yes", kind: "allow_once" },
					{ optionId: "no", name: "No", kind: "reject_once" },
				],
				opts?.signal,
			)
			return result.outcome === "selected" && result.optionId === "yes"
		},

		async input(title, placeholder, opts) {
			if (!supportsElicitation) {
				if (supportsMethod("pi_notify")) {
					// No permission-equivalent for free text — notify and resolve undefined.
					ui.notify(`Input requested: "${title}" (not supported by this client)`, "warning")
				} else {
					warnUnsupportedMethod(
						"input",
						`Extension requested free-text input "${title}" but the client supports neither form elicitation nor notifications. The call was dropped.`,
					)
				}
				return undefined
			}

			const schema: ElicitationSchema = {
				type: "object",
				properties: {
					value: {
						type: "string",
						description: placeholder,
					},
				},
				required: ["value"],
			}
			const response = await elicitForm(title, undefined, schema, opts?.signal)
			if (response === "aborted" || response === undefined) return undefined
			const value = response.value
			return typeof value === "string" ? value : undefined
		},

		async editor(title, prefill) {
			// Stays on extMethod — restricted JSON Schema has no multi-line text primitive.
			if (!supportsMethod("pi_editor")) {
				warnUnsupportedMethod(
					"editor",
					`Extension requested an editor ("${title}") but the client doesn't advertise the _kimchi.dev/pi_editor capability. The request was dropped.`,
				)
				return undefined
			}
			const response = await requestDialog("pi_editor", { method: "editor", title, prefill }, undefined)
			if (response === "aborted" || response.cancelled) return undefined
			return typeof response.value === "string" ? response.value : undefined
		},

		notify(message, type) {
			notify({ method: "notify", message, notifyType: type })
		},

		setEditorText(text) {
			notify({ method: "set_editor_text", text })
		},

		setStatus(key, text) {
			notify({
				method: "setStatus",
				statusKey: key,
				statusText: text,
			})
		},

		setTitle(title) {
			send({
				sessionId,
				update: { sessionUpdate: "session_info_update", title },
			})
		},

		setWidget: (key, content, options) => {
			// Component factories are silently dropped — no ACP equivalent for TUI trees.
			if (typeof content !== "function") {
				notify({
					method: "setWidget",
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: options?.placement,
				})
			}
		},

		showError(message) {
			notify({ method: "notify", message, notifyType: "error" })
		},

		// TUI-only stubs below — extensions probe these in conditional branches.

		onTerminalInput(_handler) {
			return () => {}
		},

		setWorkingMessage(_message) {
			// TUI streaming indicator — pi emits its own progress over ACP.
		},

		setWorkingVisible(_visible) {},

		setWorkingIndicator(_options) {},

		setHiddenThinkingLabel(_label) {},

		setFooter(factory) {
			void factory
		},

		setHeader(factory) {
			void factory
		},

		custom<T>(_factory: unknown, _options: unknown): Promise<T> {
			return Promise.resolve(undefined as T)
		},

		pasteToEditor(text) {
			ui.setEditorText(text)
		},

		getEditorText() {
			return ""
		},

		addAutocompleteProvider(_factory) {
			void _factory
		},

		setEditorComponent(_factory) {
			void _factory
		},

		getEditorComponent() {
			return undefined
		},

		getAllThemes() {
			return []
		},

		getTheme(_name) {
			return undefined
		},

		setTheme(_theme) {
			return { success: false, error: "themes are not supported in ACP mode" }
		},

		previewTheme(_name) {
			return { success: false, error: "themes are not supported in ACP mode" }
		},

		getToolsExpanded() {
			return false
		},

		setToolsExpanded(_expanded) {},

		get theme() {
			return NOOP_THEME
		},
	}

	return ui
}

const THEME_OVERRIDES: Partial<ThemeType> = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	inverse: (text) => text,
	strikethrough: (text) => text,
}

/** Theme-shaped object whose every property access is a no-op. */
function createNoopTheme(): ThemeType {
	return new Proxy({} as ThemeType, {
		get(_target, prop) {
			if (prop === "then" || prop === "catch") return undefined
			if (prop in THEME_OVERRIDES) return THEME_OVERRIDES[prop as keyof ThemeType]
			return () => undefined
		},
	})
}

function logError(method: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err)
	process.stderr.write(`acp ui ${method}: ${message}\n`)
}
