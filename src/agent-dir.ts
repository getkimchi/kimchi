import { homedir } from "node:os"
import { resolve } from "node:path"

/** Kimchi's default agent dir for a home: `~/.config/kimchi/harness`. */
export function defaultAgentDir(home = homedir()): string {
	return resolve(home, ".config", "kimchi", "harness")
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
	const inherited = env.KIMCHI_CODING_AGENT_DIR
	if (inherited && inherited !== env.KIMCHI_CODING_AGENT_DIR_DERIVED) {
		// Expand a leading `~` the way Pi's getAgentDir does.
		const expanded = inherited === "~" || inherited.startsWith("~/") ? homedir() + inherited.slice(1) : inherited
		env.KIMCHI_CODING_AGENT_DIR = resolve(expanded)
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
