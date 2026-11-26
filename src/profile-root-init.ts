/**
 * Startup-time harness-profile resolution, as a module side effect.
 *
 * WHY a side-effect module: src/ssh-proxy.ts — statically imported by
 * src/entry.ts — transitively imports src/config.ts, whose module body
 * freezes KIMCHI_CONFIG_PATH / AGENT_CONFIG_DIR at evaluation time. Import
 * order in entry.ts is therefore load-bearing: this module must be listed
 * before any import that transitively reaches config.ts, so
 * KIMCHI_PROFILE_ROOT is already published when those constants evaluate.
 * src/entry-import-graph.test.ts enforces the invariant (profile-root-init
 * must be entry.ts's first relative import).
 *
 * This lives OUTSIDE src/profile-root.ts on purpose: profile-root.ts is
 * imported by tests and library modules and must stay side-effect free;
 * only entry.ts imports this module.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { type ResolvedKimchiProfile, resolveKimchiProfile } from "./profile-root.js"

let resolved: ResolvedKimchiProfile | undefined
let resolutionError: string | undefined

try {
	resolved = resolveKimchiProfile({ rawArgv: process.argv.slice(2), env: process.env, home: homedir() })
	process.env.KIMCHI_PROFILE = resolved.name
	process.env.KIMCHI_PROFILE_ROOT = resolved.root
	process.env.KIMCHI_PROFILE_DEFAULT = resolved.defaultProfile ? "1" : "0"
	// The agent dir must be published HERE, not in entry.ts's body: config.ts
	// freezes AGENT_CONFIG_DIR = profileAgentDir() during this same import wave
	// (entry.ts → ssh-proxy.ts → config.ts), and profileAgentDir() prefers a
	// pre-existing KIMCHI_CODING_AGENT_DIR. A nested `kimchi --profile B`
	// launched from a profile-A session inherits A's value; publishing only in
	// the entry body would freeze A's agent dir into config.ts while call-time
	// consumers resolve B's — a cross-profile split-brain. Overwriting the
	// inherited value here also keeps an exported KIMCHI_CODING_AGENT_DIR
	// from influencing binary launches.
	const agentDir = join(resolved.root, "harness")
	if (process.env.KIMCHI_CODING_AGENT_DIR && !process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR) {
		process.env.KIMCHI_ORIGINAL_CODING_AGENT_DIR = process.env.KIMCHI_CODING_AGENT_DIR
	}
	process.env.KIMCHI_CODING_AGENT_DIR = agentDir
} catch (err) {
	// Surfaced by entry.ts as a clean startup error (exit 1) before anything
	// else touches stdio or the config tree.
	resolutionError = (err as Error).message
}

/** The profile resolved at import time; undefined when resolution failed. */
export function startupResolvedProfile(): ResolvedKimchiProfile | undefined {
	return resolved
}

/** The error that made profile resolution fail, if any; entry.ts turns it into exit 1. */
export function startupProfileError(): string | undefined {
	return resolutionError
}
