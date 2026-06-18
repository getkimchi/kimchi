// ACP-side ExtensionUIContext.
//
// pi-coding-agent, when embedded as a library, routes every `ctx.ui.*` call
// from extensions through whatever object was last passed to
// `session.extensionRunner.setUIContext(...)`. The default is a no-op context;
// we replace it with this one so that dialogs and fire-and-forget UI calls
// become JSON-RPC requests/notifications over ACP.
//
// Wire envelope mirrors pi's own `extension_ui_request` / `extension_ui_response`
// schema (see pi's modes/rpc/rpc-types.ts):
//   request:  extMethod(<method>, { type: "extension_ui_request", id, sessionId, ...payload })
//   response: { type: "extension_ui_response", id, value | confirmed | cancelled }
// Fire-and-forget notifications use extNotification with the same envelope,
// minus the response promise.
//
// The deliberate exception is `setTitle`: pi's rpc-mode emits it via
// `extension_ui_request`, but ACP has a native `session_info_update`
// notification that every ACP client understands. Routing setTitle through
// the native channel means clients don't need a custom RPC to render a
// session title.
//
// Client capability gating is keyed off `clientCapabilities._meta["kimchi.dev"].pi`
// — a client that didn't advertise `pi: true` gets a graceful no-op (confirm
// resolves false, dialogs resolve undefined, etc.) instead of a
// method-not-found round-trip.

import { randomUUID } from "node:crypto"
import type { AgentSideConnection, ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext, Theme as ThemeType } from "@earendil-works/pi-coding-agent"
import { AVAILABLE_METHODS, getClientSupportsUiMethods } from "./capabilities.js"
import { requestWithAbort } from "./utils.js"

type DialogResponse = {
	value?: string | boolean
	confirmed?: boolean
	cancelled?: boolean
}

const REQUEST_TYPE = "extension_ui_request"

const METHODS = AVAILABLE_METHODS.pi

const NOOP_THEME = createNoopTheme()

type MethodType = (typeof METHODS)[keyof typeof METHODS]

/**
 * Build an `ExtensionUIContext` that proxies all interaction through the ACP
 * connection. The returned object is bound to a single session for its
 * lifetime; do not share it across sessions.
 *
 * Fire-and-forget methods (notify/setStatus/setWidget/setEditorText/setTitle)
 * swallow errors and log to stderr — they cannot meaningfully surface
 * failure to the extension that initiated them. Dialog methods translate ACP
 * errors into the same default return values a real TUI dialog would emit
 * on dismiss/abort, so extensions never see a rejected promise from UI
 * calls (matches pi's interactive TUI semantics).
 */
export function createAcpUIContext(
	conn: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
	send: (params: SessionNotification) => void,
): ExtensionUIContext {
	// `clientCapabilities` is fixed at ACP initialize time and never changes
	// for the connection's lifetime, so compute the support flag once instead
	// of checking on every UI call.
	const supportsUi = getClientSupportsUiMethods(clientCapabilities)

	async function requestDialog<T extends DialogResponse>(
		method: MethodType,
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<T | "aborted"> {
		try {
			return await requestWithAbort(
				conn.extMethod(method, {
					type: REQUEST_TYPE,
					id: randomUUID(),
					sessionId,
					...payload,
				}) as Promise<T>,
				signal,
			)
		} catch (err) {
			// Treat client-side errors (method not supported, transport failure,
			// invalid response shape) as a cancellation — matches pi's TUI
			// semantics where a closed/dismissed dialog resolves to the default
			// value rather than rejecting the extension's promise.
			logError(method, err)
			return { cancelled: true } as T
		}
	}

	function notify(method: MethodType, payload: Record<string, unknown>): void {
		// Fire-and-forget: notify rejections must never surface to extensions
		// (no return value), but should be visible during development.
		conn
			.extNotification(method, {
				type: REQUEST_TYPE,
				id: randomUUID(),
				sessionId,
				...payload,
			})
			.catch((err) => logError(method, err))
	}

	// TUI-only surface (footer/header/widget-component/custom): no ACP
	// equivalent. Stubs below satisfy the type contract without doing
	// anything. Note `setWidget` does support the string[] branch — it
	// forwards to the client as a real notification, matching pi's rpc-mode.
	// Theme is exposed as a Proxy so the getter never throws; the public
	// pi-coding-agent index doesn't re-export the theme singleton and the
	// Theme constructor needs full color records we don't have access to.
	const ui: ExtensionUIContext = {
		async select(title, options, opts) {
			if (!supportsUi) return undefined
			const response = await requestDialog(
				METHODS.select,
				{ method: "select", title, options, timeout: opts?.timeout },
				opts?.signal,
			)
			if (response === "aborted" || response.cancelled) return undefined
			return typeof response.value === "string" ? response.value : undefined
		},

		async confirm(title, message, opts) {
			if (!supportsUi) return false
			const response = await requestDialog(
				METHODS.confirm,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				opts?.signal,
			)
			if (response === "aborted" || response.cancelled) return false
			// rpc-mode uses `confirmed`; some clients may use `value` for
			// symmetry with select/input. Accept either.
			if (typeof response.value === "boolean") return response.value
			return response.confirmed === true
		},

		async input(title, placeholder, opts) {
			if (!supportsUi) return undefined
			const response = await requestDialog(
				METHODS.input,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				opts?.signal,
			)
			if (response === "aborted" || response.cancelled) return undefined
			return typeof response.value === "string" ? response.value : undefined
		},

		async editor(title, prefill) {
			if (!supportsUi) return undefined
			const response = await requestDialog(METHODS.editor, { method: "editor", title, prefill }, undefined)
			if (response === "aborted" || response.cancelled) return undefined
			return typeof response.value === "string" ? response.value : undefined
		},

		notify(message, type) {
			notify(METHODS.notify, { method: "notify", message, notifyType: type })
		},

		// TUI-only methods below this line — kept as honest no-op stubs so
		// extensions that probe ctx.ui.* in conditional branches don't crash.

		onTerminalInput(_handler) {
			return () => {}
		},

		setStatus(key, text) {
			if (!supportsUi) return
			notify(METHODS.setStatus, {
				method: "setStatus",
				statusKey: key,
				statusText: text,
			})
		},

		setWorkingMessage(_message) {
			// TUI streaming indicator — pi emits its own progress notifications
			// over ACP (message_update), which the client renders.
		},

		setWorkingVisible(_visible) {
			// See setWorkingMessage.
		},

		setWorkingIndicator(_options) {
			// See setWorkingMessage.
		},

		setHiddenThinkingLabel(_label) {
			// TUI-only label override; not surfaced over ACP.
		},

		setWidget: (key, content, options) => {
			// The non-function branch forwards to the client via the notifier;
			// component factories are silently dropped (no ACP equivalent).
			if (!supportsUi) return
			if (typeof content !== "function") {
				notify(METHODS.setWidget, {
					method: "setWidget",
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: options?.placement,
				})
			}
		},

		setFooter(factory) {
			// TUI footer component — no ACP surface.
			void factory
		},

		setHeader(factory) {
			// TUI header component — no ACP surface.
			void factory
		},

		setTitle(title) {
			// Deliberate divergence from pi's rpc-mode: ACP has a native
			// session_info_update notification that every ACP client renders,
			// so we use that instead of a parallel extension_ui_request. The
			// rpc-mode approach exists because rpc-mode has no native
			// session-title channel.
			send({
				sessionId,
				update: { sessionUpdate: "session_info_update", title },
			})
		},

		custom<T>(_factory: unknown, _options: unknown): Promise<T> {
			// Interactive-mode-only overlays. TUI rendering isn't a thing over
			// ACP; resolve undefined so callers that ignore the return value
			// aren't broken, but extensions that rely on overlays cannot work
			// in ACP mode regardless.
			return Promise.resolve(undefined as T)
		},

		pasteToEditor(text) {
			ui.setEditorText(text)
		},

		setEditorText(text) {
			if (!supportsUi) return
			notify(METHODS.set_editor_text, { method: "set_editor_text", text })
		},

		getEditorText() {
			return ""
		},

		addAutocompleteProvider(_factory) {
			// TUI-only behaviour.
			void _factory
		},

		setEditorComponent(_factory) {
			// TUI-only behaviour.
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

		getToolsExpanded() {
			return false
		},

		setToolsExpanded(_expanded) {
			// TUI-only state.
		},

		get theme() {
			return NOOP_THEME
		},
	}

	return ui
}

/**
 * Build a Theme-shaped object whose every property access is a no-op. Used
 * to satisfy `ctx.ui.theme` without dragging in pi's full color machinery —
 * extensions that read this in ACP mode are reading into a black hole anyway.
 */
function createNoopTheme(): ThemeType {
	return new Proxy({} as ThemeType, {
		get(_target, prop) {
			// Methods return undefined; data accesses return empty strings so
			// template-literal concatenation doesn't blow up.
			if (prop === "then" || prop === "catch") return undefined
			return () => undefined
		},
	})
}

function logError(method: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err)
	process.stderr.write(`acp ui ${method}: ${message}\n`)
}
