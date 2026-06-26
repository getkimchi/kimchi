import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { TeleportRefusal } from "./commands/errors.js"
import { runRemoteSessions } from "./commands/remote-sessions.js"
import { runSshConfig } from "./commands/ssh-config.js"
import { runSync } from "./commands/sync.js"
import { runTeleport } from "./commands/teleport.js"
import { runTerminal } from "./commands/terminal.js"
import type { TeleportContext } from "./types.js"

type CommandFn = (args: string, ctx: TeleportContext) => Promise<void>

function makeHandler(run: CommandFn) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const apiKey = loadConfig().apiKey
		const tctx: TeleportContext = {
			apiKey,
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
			cwd: ctx.cwd,
			signal: ctx.signal,
			ui: ctx.ui,
			sessionFile: ctx.sessionManager.getSessionFile(),
		}
		try {
			await run(args, tctx)
		} catch (err) {
			if (err instanceof TeleportRefusal) return
			const message = err instanceof Error ? err.message : String(err)
			ctx.ui.notify(message, "error")
		}
	}
}

export default function teleportExtension(pi: ExtensionAPI): void {
	if (process.env.KIMCHI_EXPERIMENTAL_TELEPORT === undefined || process.env.KIMCHI_EXPERIMENTAL_TELEPORT === "") {
		return
	}
	pi.registerCommand("teleport", {
		description: "Open a kimchi PTY session in a sandbox workspace",
		handler: makeHandler(runTeleport),
	})
	pi.registerCommand("terminal", {
		description: "Open a raw SSH shell into a sandbox workspace",
		handler: makeHandler(runTerminal),
	})
	pi.registerCommand("sync", {
		description: "Sync files between local and sandbox workspace",
		handler: makeHandler(runSync),
	})
	pi.registerCommand("remote-sessions", {
		description: "Browse workspaces and their kimchi sessions",
		handler: makeHandler(runRemoteSessions),
	})
	pi.registerCommand("ssh-config", {
		description: "Refresh ~/.config/kimchi/ssh_config from your workspaces",
		handler: makeHandler(runSshConfig),
	})
}
