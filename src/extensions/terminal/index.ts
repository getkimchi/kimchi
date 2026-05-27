import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { TerminalComponent } from "./terminal-component.js"
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
          overlayTui = tui
          const core = await createGhosttyCore()

          transport = new WebSocketTransport({
            url: "ws://valid-marital-lorikeet-000000-ce70.remote.kimchi.localhost:30000/connect?mode=pty&name=pty-fun",
            tokenProvider: () => "eyJhbGciOiAiRWREU0EiLCAidHlwIjogIkpXVCIsICJraWQiOiAiWkFIR0NXcjZIY1BCc1BNTVF6enNyNGFxQjdOMmtCR3dUcGZPdU1wVUEwUSJ9.eyJpc3MiOiAibG9jYWwua2ltY2hpLmRldiIsICJleHAiOiAxNzc5OTgzNDE1LCAic2Vzc2lvbl9pZCI6ICJzLWRlMmYxOWRiLWI0YTUtNGE3MS1iNDUzLTFkOWRkN2IxMzQxNCJ9.FY2wNTEGSsjiXQtAHd864HtDxJLW_8qcqkX1olyXsKcUjc5dRumHmtBXpjLiyaHVrld6ESbrTs2Kf6b7AWdzCw",
            onData: (data: Uint8Array | string) => {
              if (data instanceof Uint8Array) {
                component?.terminal.writeRaw(data)
              } else {
                component?.terminal.writeString(data)
              }
            },
            onClose: () => {
              done(undefined)
            },
            onError: (event: Event) => {
              ctx.ui.notify(`Connenction error: ${(event as ErrorEvent).message}`, "error")
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

          // session.connect(parsed, {
          //   onData: (data) => {
          //     component!.writeRemoteData(data)
          //     tui.requestRender()
          //   },
          //   onStderr: (data) => {
          //     component!.writeRemoteData(data)
          //     tui.requestRender()
          //   },
          //   onError: (err) => {
          //     ctx.ui.notify(`Connenction error: ${(err as Error).message}`, "error")
          //     tui.requestRender()
          //   },
          //   onClose: () => {
          //     done(undefined)
          //   },
          // }).catch((err) => {
          //   ctx.ui.notify(`Connection failed: ${(err as Error).message}`, "error")
          // })

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
        overlayTui?.setShowHardwareCursor(false)
        transport.close()
      })
    },
  })
}
