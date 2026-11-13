/**
 * `kimchi memory ...` — user-facing memory management (overview, list,
 * search, delete, reset). A thin shell over the shared admin core
 * (src/extensions/memory/admin.ts); the in-session /memory command uses
 * the same core. Deletion is user-only by design — the model never gets a
 * write tool (docs/memory-extension.md). enable/disable surface the core's
 * usage-style error for session-less callers: the runtime toggle lives in
 * interactive sessions; the persistent feature switch is
 * `kimchi resources enable|disable extensions.memory`.
 */
import { runAdminCommand } from "../extensions/memory/admin.js"
import { startMemoryDashboard } from "../extensions/memory/dashboard.js"
import { confirm } from "./_helpers.js"

export async function runMemory(args: string[]): Promise<number> {
	const result = await runAdminCommand(args, {
		cwd: process.cwd(),
		confirm: confirmReset,
		// The terminal-only launcher: `kimchi memory dashboard` runs the
		// loopback dashboard until Ctrl+C; a SIGINT closes the server and
		// resolves so the process exits with code 0.
		launchDashboard: async ({ port, openBrowser }) => {
			const server = await startMemoryDashboard({ port, openBrowser })
			console.log(`Memory extraction dashboard: ${server.url}`)
			console.log("Ctrl+C to stop.")
			await new Promise<void>((resolve) => {
				process.once("SIGINT", () => {
					server.close()
					resolve()
				})
			})
			return { text: "Dashboard stopped.", json: JSON.stringify({ url: server.url }, null, 2), code: 0 }
		},
	})
	console.log(result.useJson ? result.json : result.text)
	return result.code
}

/**
 * Destructive-op confirmation: [Y/n] with yes default (matching the update
 * command). Non-interactive stdin declines with a hint instead of hanging —
 * scripts pass --yes.
 */
async function confirmReset(message: string): Promise<boolean> {
	if (process.stdin.isTTY !== true) {
		console.log(`${message}\nNot running interactively — pass --yes to proceed.`)
		return false
	}
	return confirm(`${message} [Y/n]: `)
}
