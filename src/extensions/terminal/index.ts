import { appendFileSync } from "fs"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { parseTerminalArgs } from "./args.js"
import { SshSession } from "./ssh-session.js"
import { TerminalComponent, toRawAnsi } from "./terminal-component.js"
import { WebSocketTransport } from "./websocket-transport.js"
import { createXtermCore } from "./xterm-core.js"

export default function terminalExtension(pi: ExtensionAPI): void {
	pi.registerCommand("terminal", {
		description: "Open an SSH terminal overlay. Usage: /terminal [user@]host[:port]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const raw = args.trim()
			let parsed
			try {
				parsed = parseTerminalArgs(raw)
			} catch (e) {
				ctx.ui.notify(String(e), "error")
				return
			}

			// const session = new SshSession()
			let component: TerminalComponent | undefined
			let overlayTui: TUI | undefined

			let transport: WebSocketTransport | undefined

			ctx.ui
				.custom(
					async (tui, _theme, _kb, done) => {
						// NOTE(patrick.pichler): required to enable getting mouse events.
						console.log("\x1b[?1000h\x1b[?1006h")

						const rows = tui.terminal.rows
						const cols = tui.terminal.columns
						parsed.cols = cols
						parsed.rows = rows
						console.log(">>>>>>>", rows, cols)

						overlayTui = tui
						const core = createXtermCore(cols, rows)

						transport = new WebSocketTransport({
							url: "ws://surprised-literate-basilisk-000000-89b4.remote.kimchi.localhost:30000/connect?mode=pty&name=pty-fun-4",
							tokenProvider: () =>
								"eyJhbGciOiAiRWREU0EiLCAidHlwIjogIkpXVCIsICJraWQiOiAiQ2FLRGF0Z0kxNC1rUGZvN2VJYXFiT1U1TC1tRkg4cXhoTlF1ZjU3RnJGcyJ9.eyJpc3MiOiAibG9jYWwua2ltY2hpLmRldiIsICJleHAiOiAxNzgwMjY2MDA3LCAic2Vzc2lvbl9pZCI6ICJzLWQ4NDhlY2JjLTA5Y2MtNGE1Yy04NDk0LTJiODNjZjM0YzA2NyJ9.2dxwP0nA1YpAxqPyR8XGodpiIXAD9UEu7_GnU8DGSsuOBLEZVeYDZrdqdca-3Y2ZG8GrDfJk90V6anx7dQpYBw",
							onData: async (data: Uint8Array | string) => {
								appendFileSync("/tmp/wsdump", data)

								if (data instanceof Uint8Array) {
									await component?.terminal.writeRaw(data)
								} else {
									await component?.terminal.writeString(data)
								}
								tui.requestRender()
							},
							onClose: () => {
								done(undefined)
							},
							onError: (err: Error) => {
								ctx.ui.notify(`Connection error: ${err.message}: ${err.cause}`, "error")
								done(undefined)
							},
						})

						component = new TerminalComponent(tui, transport, core)

						if (component) {
							await component.terminal.writeString(`Connecting to ${parsed.host}...\r\n`)
						}
						tui.requestRender()

						transport.connect()

						tui.setShowHardwareCursor(true)
						return component
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "top-left",
							width: "100%",
							maxHeight: "100%",
						},
					},
				)
				.catch((err) => {
					ctx.ui.notify(`Error: ${(err as Error).message}`, "error")
				})
				.finally(() => {
					// NOTE(patrick.pichler): disable mouse capture again.
					console.log("\x1b[?1000l\x1b[?1006l")
					overlayTui?.setShowHardwareCursor(false)
					transport?.close()
				})
		},
	})
}
