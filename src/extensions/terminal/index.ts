import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { TerminalComponent, toRawAnsi } from "./terminal-component.js"
import { createGhosttyCore } from "./ghostty-loader.js"
import { SshSession } from "./ssh-session.js"
import { parseTerminalArgs } from "./args.js"
import { WebSocketTransport } from "./websocket-transport.js"

export default function terminalExtension(pi: ExtensionAPI): void {
  pi.registerCommand("terminal", {
    description: "Open an SSH terminal overlay. Usage: /terminal [user@]host[:port]",
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
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

      ctx.ui.custom(
        async (tui, _theme, _kb, done) => {
          console.log("\x1b[?1000h\x1b[?1006h")

          overlayTui = tui
          const core = await createGhosttyCore()

          transport = new WebSocketTransport({
            url: "ws://valid-marital-lorikeet-000000-ce70.remote.kimchi.localhost:30000/connect?mode=pty&name=pty-fun",
            tokenProvider: () => "eyJhbGciOiAiRWREU0EiLCAidHlwIjogIkpXVCIsICJraWQiOiAiWkFIR0NXcjZIY1BCc1BNTVF6enNyNGFxQjdOMmtCR3dUcGZPdU1wVUEwUSJ9.eyJpc3MiOiAibG9jYWwua2ltY2hpLmRldiIsICJleHAiOiAxNzgwNzUxNjk0LCAic2Vzc2lvbl9pZCI6ICJzLWRlMmYxOWRiLWI0YTUtNGE3MS1iNDUzLTFkOWRkN2IxMzQxNCJ9.pKlRf2Qccbq5_a47tuus1Vfo1ipCqRqX8xT3FzqxbmkZ40oFhvKyeDLprrbNanM1oP_enWGlnR4wuW6eLKpdCQ",
            onData: (data: Uint8Array | string) => {
              if (data instanceof Uint8Array) {
                component?.terminal.writeRaw(data)
              } else {
                component?.terminal.writeString(data)
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

          component!.terminal.writeString(`Connecting to ${parsed.host}...\r\n`)
          tui.requestRender()

          transport.connect()

          let rows = tui.terminal.rows
          let cols = tui.terminal.columns
          parsed.cols = cols
          parsed.rows = rows

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
      ).catch((err) => {
        ctx.ui.notify(`Error: ${(err as Error).message}`, "error")
      }).finally(() => {
        console.log("\x1b[?1000l\x1b[?1006l")
        overlayTui?.setShowHardwareCursor(false)
        transport?.close()
      })
    },
  })
}
