import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { TerminalComponent } from "./terminal-component.js"
import { createGhosttyCore } from "./ghostty-loader.js"
import { SshSession } from "./ssh-session.js"
import { parseTerminalArgs } from "./args.js"
import fs from 'node:fs'
import { sleep } from "../../modes/teleport/index.js"

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

      const session = new SshSession()
      let component: TerminalComponent | undefined
      let overlayTui: TUI | undefined

      ctx.ui.custom(
        async (tui, _theme, _kb, done) => {
          overlayTui = tui
          const core = await createGhosttyCore()
          component = new TerminalComponent(tui, session, core)

          component!.terminal.writeString(`Connecting to ${parsed.host}...\r\n`)
          tui.requestRender()

          session.connect(parsed, {
            onData: (data) => {
              component!.writeRemoteData(data)
              tui.requestRender()
            },
            onStderr: (data) => {
              component!.writeRemoteData(data)
              tui.requestRender()
            },
            onError: (err) => {
              ctx.ui.notify(`Connenction error: ${(err as Error).message}`, "error")
              tui.requestRender()
            },
            onClose: () => {
              done(undefined)
            },
          }).catch((err) => {
            ctx.ui.notify(`Connection failed: ${(err as Error).message}`, "error")
          })

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
        session.close()
        component?.dispose()
      })
    },
  })
}
