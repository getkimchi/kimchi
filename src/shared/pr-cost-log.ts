import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { format } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

const DEBUG_NAMESPACE = "kimchi:pr-cost"

// Bun's debuglog has no `enabled` getter, so NODE_DEBUG is read here: a name or a `prefix*`, in any case.
const enablesNamespace = (entry: string) =>
	entry === DEBUG_NAMESPACE || (entry.endsWith("*") && DEBUG_NAMESPACE.startsWith(entry.slice(0, -1)))

/** Opt-in diagnostics: `NODE_DEBUG=kimchi:pr-cost` appends them to `<agent dir>/logs/pr-cost.log`, never to the TUI or ACP. */
export function debugPRCost(message: string, ...details: unknown[]): void {
	if (!(process.env.NODE_DEBUG ?? "").toLowerCase().split(",").some(enablesNamespace)) return
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
