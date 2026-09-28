import "../integrations/codex.js" // side-effect: register integration
import { runForeground } from "../integrations/spawn.js"
import { prepareTool } from "./_helpers.js"

/**
 * `kimchi codex [args]` — launch Codex using the provider configuration
 * written to ~/.codex/config.toml by `kimchi setup-tools`.
 *
 * Do not inject KIMCHI_API_KEY here: the generated Codex provider already
 * contains the Authorization header, and forwarding the key would expose it
 * unnecessarily to Codex and any child processes it starts.
 *
 * All args after `codex` are forwarded to the binary verbatim — that's how
 * `kimchi codex --help`, `kimchi codex exec "..."`, etc. work without us
 * having to know Codex's flag set.
 */
export async function runCodex(args: string[]): Promise<number> {
	try {
		const prepped = await prepareTool("codex", "inject")
		if (!prepped) return 1

		return await runForeground("codex", args)
	} catch (err) {
		console.error("kimchi codex:", err instanceof Error ? err.message : String(err))
		return 1
	}
}
