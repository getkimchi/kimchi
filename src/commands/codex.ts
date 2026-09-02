import "../integrations/codex.js" // side-effect: register integration
import { runForeground } from "../integrations/spawn.js"
import { prepareTool } from "./_helpers.js"

/**
 * `kimchi codex [args]` — launch Codex with the KIMCHI_API_KEY env var
 * injected for this run only (inject mode). Codex reads its provider
 * config from ~/.codex/config.toml (written by `kimchi setup-tools`),
 * so this command requires a prior setup-tools run. The KIMCHI_API_KEY
 * env var is passed through for any Kimchi-aware MCP servers Codex
 * might spawn — Codex itself does not read it.
 *
 * All args after `codex` are forwarded to the binary verbatim — that's how
 * `kimchi codex --help`, `kimchi codex exec "..."`, etc. work without us
 * having to know Codex's flag set.
 */
export async function runCodex(args: string[]): Promise<number> {
	try {
		const prepped = await prepareTool("codex", "inject")
		if (!prepped) return 1

		return await runForeground("codex", args, { KIMCHI_API_KEY: prepped.apiKey })
	} catch (err) {
		console.error("kimchi codex:", err instanceof Error ? err.message : String(err))
		return 1
	}
}
