import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { TerminalComponent } from "./terminal-component.js"
import { SshSession } from "./ssh-session.js"
import { parseTerminalArgs } from "./args.js"

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
          component = new TerminalComponent(tui, session)

          component!.terminal.write(`Connecting to ${parsed.host}...\r\n`)
          tui.requestRender()

          try {
            await session.connect(parsed, {
              onData: (data) => {
                component!.terminal.write(data)
                tui.requestRender()
              },
              onStderr: (data) => {
                component!.terminal.write(data)
                tui.requestRender()
              },
              onError: (err) => {
                component!.terminal.write(
                  `\r\nSSH error: ${err.message}\r\n`,
                )
                tui.requestRender()
              },
              onClose: () => {
                done(undefined)
              },
            })
          } catch (err) {
            ctx.ui.notify(`Connection failed: ${(err as Error).message}`, "error")
            // component.terminal.write(
            // 	`\r\nConnection failed: ${(err as Error).message}\r\n`,
            // )
            // tui.requestRender()
            // Auto-dismiss after a short delay so user sees the error
            // setTimeout(() => done(undefined), 3000)
            // Return component so overlay still shows during delay
            return component
          }

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
        console.log(err)
        // dismissed
      }).finally(() => {
        overlayTui?.setShowHardwareCursor(false)
        session.close()
        component?.dispose()
      })
    },
  })
}
