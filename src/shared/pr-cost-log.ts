import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { format } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

/**
 * Opt-in diagnostics for the request and plan identity the Kimchi gateway uses to report PR costs. They never write
 * through the live TUI or ACP transport: `NODE_DEBUG=kimchi:pr-cost` saves them in the agent directory's
 * `logs/pr-cost.log`.
 */
export function debugPRCost(message: string, ...details: unknown[]): void {
	// Bun's debuglog lacks Node's enabled getter. Match NODE_DEBUG without calling its stderr logger.
	const namespaces = (process.env.NODE_DEBUG ?? "")
		.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/,/g, "$|^")
	if (!new RegExp(`^${namespaces}$`, "i").test("kimchi:pr-cost")) return
	try {
		const directory = join(getAgentDir(), "logs")
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		appendFileSync(
			join(directory, "pr-cost.log"),
			`${new Date().toISOString()} ${process.pid} ${format(message, ...details)}\n`,
			{ mode: 0o600 },
		)
	} catch {
		// Diagnostics cannot interrupt a request or fall back to terminal output.
	}
}
