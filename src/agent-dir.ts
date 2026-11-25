import { homedir } from "node:os"
import { resolve } from "node:path"

/** Kimchi's default agent dir for a home: `~/.config/kimchi/harness`. */
export function defaultAgentDir(home = homedir()): string {
	return resolve(home, ".config", "kimchi", "harness")
}

/**
 * Decide the agent dir at startup and write it back to `env`, which child
 * processes inherit. An inherited `KIMCHI_CODING_AGENT_DIR` is an explicit
 * choice and is kept. A dir Kimchi derived from HOME carries
 * `KIMCHI_CODING_AGENT_DIR_DERIVED=1`, so a child (e.g. a nested Kimchi with
 * another HOME) recomputes it instead of taking the parent's.
 */
export function applyAgentDirEnv(env: NodeJS.ProcessEnv = process.env): string {
	if (env.KIMCHI_CODING_AGENT_DIR && env.KIMCHI_CODING_AGENT_DIR_DERIVED !== "1") {
		env.KIMCHI_CODING_AGENT_DIR = resolve(env.KIMCHI_CODING_AGENT_DIR)
		delete env.KIMCHI_CODING_AGENT_DIR_DERIVED
	} else {
		env.KIMCHI_CODING_AGENT_DIR = defaultAgentDir()
		env.KIMCHI_CODING_AGENT_DIR_DERIVED = "1"
	}
	return env.KIMCHI_CODING_AGENT_DIR
}
