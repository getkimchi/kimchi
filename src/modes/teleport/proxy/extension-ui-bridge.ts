import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { RpcAgentEventLike } from "../ws/events.js"
import type { RemoteRpcClient } from "../ws/rpc-client.js"

/**
 * Bridges server-side extension UI requests to the local TUI context.
 *
 * Handles the `extension_ui_request` RPC event: dispatches `select`, `confirm`,
 * `input`, `editor`, `notify`, `setStatus`, `setTitle`, `setWidget`,
 * `set_editor_text` to the bound {@link ExtensionUIContext}, and sends
 * responses back via `extension_ui_response`.
 *
 * Requests that arrive before the UI is bound are buffered and replayed
 * once {@link bind} is called (fixes the attach race).
 */
export class ExtensionUiBridge {
	private _uiContext?: ExtensionUIContext
	private readonly _pending: Array<{
		event: RpcAgentEventLike
		sendResponse: (resp: Record<string, unknown>) => void
	}> = []

	/** Bind (or rebind) the UI context and flush any buffered requests. */
	bind(ui: ExtensionUIContext | undefined): void {
		this._uiContext = ui
		if (!ui) return
		const buffered = this._pending.splice(0, this._pending.length)
		for (const p of buffered) {
			void this._dispatch(p.event, p.sendResponse)
		}
	}

	get uiContext(): ExtensionUIContext | undefined {
		return this._uiContext
	}

	/** Handle an incoming extension_ui_request event. */
	async handle(event: RpcAgentEventLike, rpcClient: RemoteRpcClient): Promise<void> {
		const id = event.id as string | undefined
		const sendResponse = (resp: Record<string, unknown>) => {
			if (!id) return
			void rpcClient.sendOneWay({ type: "extension_ui_response", id, ...resp })
		}
		if (!this._uiContext) {
			this._pending.push({ event, sendResponse })
			return
		}
		await this._dispatch(event, sendResponse)
	}

	private async _dispatch(
		event: RpcAgentEventLike,
		sendResponse: (resp: Record<string, unknown>) => void,
	): Promise<void> {
		const ui = this._uiContext
		if (!ui) return
		const id = event.id as string | undefined
		const method = event.method as string | undefined
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
					console.error(`kimchi: unhandled extension_ui_request method "${method}"`)
					if (id) sendResponse({ cancelled: true })
			}
		} catch {
			if (id) sendResponse({ cancelled: true })
		}
	}
}
