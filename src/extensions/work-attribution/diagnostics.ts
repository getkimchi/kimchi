import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { format } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

/** Opt-in diagnostics must never write through the live TUI or ACP transport. */
export function debugWorkAttribution(message: string, ...details: unknown[]): void {
	// Bun's debuglog lacks Node's enabled getter. Match NODE_DEBUG without calling its stderr logger.
	const namespaces = (process.env.NODE_DEBUG ?? "")
		.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/,/g, "$|^")
	if (!new RegExp(`^${namespaces}$`, "i").test("kimchi:work-attribution")) return
	try {
		const directory = join(getAgentDir(), "logs")
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		appendFileSync(
			join(directory, "work-attribution.log"),
			`${new Date().toISOString()} ${process.pid} ${format(message, ...details)}\n`,
			{ mode: 0o600 },
		)
	} catch {
		// Diagnostics cannot interrupt a request or fall back to terminal output.
	}
}
