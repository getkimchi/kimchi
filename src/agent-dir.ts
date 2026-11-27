import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** The harness skills dir relative to HOME, as configured skill paths spell it. */
export const HARNESS_SKILLS_REL = join(".config", "kimchi", "harness", "skills")

/** Kimchi's default agent dir: `~/.config/kimchi/harness`. */
export function defaultAgentDir(): string {
	return resolve(homedir(), ".config", "kimchi", "harness")
}

/**
 * Decide the agent dir at startup and write it back to `env`, which child
 * processes inherit. A dir Kimchi derived from HOME is also stored in
 * `KIMCHI_CODING_AGENT_DIR_DERIVED`; a child that inherits the same value
 * recomputes it from its own HOME instead of taking the parent's. Any other
 * inherited `KIMCHI_CODING_AGENT_DIR` is an explicit choice: it is kept and
 * the marker is removed, so children keep it too.
 */
export function applyAgentDirEnv(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = explicitAgentDir(env)
	if (explicit) {
		// Expand a leading `~` the way Pi's getAgentDir does.
		const tilde =
			explicit === "~" || explicit.startsWith("~/") || (process.platform === "win32" && explicit.startsWith("~\\"))
		env.KIMCHI_CODING_AGENT_DIR = resolve(tilde ? homedir() + explicit.slice(1) : explicit)
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete env.KIMCHI_CODING_AGENT_DIR_DERIVED
	} else {
		env.KIMCHI_CODING_AGENT_DIR = defaultAgentDir()
		env.KIMCHI_CODING_AGENT_DIR_DERIVED = env.KIMCHI_CODING_AGENT_DIR
	}
	return env.KIMCHI_CODING_AGENT_DIR
}

/** The agent dir when it was set explicitly rather than derived from HOME. */
export function explicitAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const agentDir = env.KIMCHI_CODING_AGENT_DIR
	return agentDir && agentDir !== env.KIMCHI_CODING_AGENT_DIR_DERIVED ? agentDir : undefined
}
