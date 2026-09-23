/**
 * `kimchi memory ...` — user-facing memory management (overview, list,
 * search, delete, reset). A thin shell over the shared admin core
 * (src/extensions/memory/admin.ts); the in-session /memory command uses
 * the same core. Deletion is user-only by design — the model never gets a
 * write tool (docs/memory-extension.md).
 */
import { runAdminCommand } from "../extensions/memory/admin.js"
import { confirm } from "./_helpers.js"

export async function runMemory(args: string[]): Promise<number> {
	const result = await runAdminCommand(args, {
		cwd: process.cwd(),
		confirm: confirmReset,
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
