/**
 * Startup-time harness-environment resolution, as a module side effect.
 *
 * WHY a side-effect module: src/ssh-proxy.ts — statically imported by
 * src/entry.ts — transitively imports src/config.ts, whose module body
 * freezes KIMCHI_CONFIG_PATH / AGENT_CONFIG_DIR at evaluation time. Import
 * order in entry.ts is therefore load-bearing: this module must be listed
 * before any import that transitively reaches config.ts, so KIMCHI_ENV_ROOT
 * is already published when those constants evaluate. src/entry-import-graph.test.ts
 * enforces the invariant (env-root-init must be entry.ts's first relative import).
 *
 * This lives OUTSIDE src/env-root.ts on purpose: env-root.ts is imported by
 * tests and library modules and must stay side-effect free; only entry.ts
 * imports this module.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { type ResolvedKimchiEnv, resolveKimchiEnv } from "./env-root.js"

let resolved: ResolvedKimchiEnv | undefined
let resolutionError: string | undefined

try {
	resolved = resolveKimchiEnv({ rawArgv: process.argv.slice(2), env: process.env, home: homedir() })
	process.env.KIMCHI_ENV = resolved.name
	process.env.KIMCHI_ENV_ROOT = resolved.root
	process.env.KIMCHI_ENV_LEGACY_DEFAULT = resolved.legacyDefault ? "1" : "0"
	// The agent dir must be published HERE, not in entry.ts's body: config.ts
	// freezes AGENT_CONFIG_DIR = envAgentDir() during this same import wave
	// (entry.ts → ssh-proxy.ts → config.ts), and envAgentDir() prefers a
	// pre-existing KIMCHI_CODING_AGENT_DIR. A nested `kimchi --env B` launched
	// from an env-A session inherits A's value; publishing only in the entry
	// body would freeze A's agent dir into config.ts while call-time consumers
	// resolve B's — a cross-env split-brain. Overwriting the inherited value
	// here also restores the pre-environments behavior where binary launches
	// ignored an exported KIMCHI_CODING_AGENT_DIR entirely.
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

/** The env resolved at import time; undefined when resolution failed. */
export function startupResolvedEnv(): ResolvedKimchiEnv | undefined {
	return resolved
}

/** The error that made env resolution fail, if any; entry.ts turns it into exit 1. */
export function startupEnvError(): string | undefined {
	return resolutionError
}
