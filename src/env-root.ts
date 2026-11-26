/**
 * Harness-local environment resolution.
 *
 * An environment ("env") is a self-contained kimchi state tree — config,
 * logins, sessions, memory, skills — rooted at one directory:
 *
 *   - the default env is the legacy layout `~/.config/kimchi/` used IN PLACE
 *     when it already exists (nothing moves, nothing migrates);
 *   - on a machine with no legacy state, the default env lives at
 *     `~/.config/kimchi/envs/default/`;
 *   - any other env lives at `~/.config/kimchi/envs/<name>/`.
 *
 * Selection: `--env <name>` (highest precedence) or `KIMCHI_ENV`. The name
 * `default` always resolves through the default rule above, so
 * `--env default` is exactly equivalent to passing nothing.
 *
 * Import constraint: this module must stay free of pi-mono transitive imports
 * (node builtins only) because src/entry.ts imports it statically before
 * PI_PACKAGE_DIR is set — src/entry-import-graph.test.ts enforces this.
 */

import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ENV_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MAX_ENV_NAME_LENGTH = 32

/** The name of the default environment (the legacy layout when it exists). */
export const DEFAULT_ENV_NAME = "default"

export interface ResolvedKimchiEnv {
	/** Environment name; `default` for the default env. */
	name: string
	/** Directory holding this env's state tree (config.json, harness/, ...). */
	root: string
	/** True when root is the legacy top-level layout used in place. */
	legacyDefault: boolean
}

/** Inputs `resolveKimchiEnv` needs; every path source is injected so the
 *  resolution matrix is unit-testable without touching the real home. */
export interface KimchiEnvResolutionInput {
	rawArgv: string[]
	env: NodeJS.ProcessEnv
	home: string
}

/**
 * Validate an environment name. Returns an error message when invalid,
 * undefined when valid. Strict allowlist blocks path traversal (`..`,
 * separators, NUL) and case/typo drift before any path is derived.
 */
export function validateEnvName(name: string): string | undefined {
	if (name.length === 0) return "environment name must not be empty"
	if (name.length > MAX_ENV_NAME_LENGTH) {
		return `environment name is longer than ${MAX_ENV_NAME_LENGTH} characters: ${JSON.stringify(name)}`
	}
	if (!ENV_NAME_PATTERN.test(name)) {
		return `invalid environment name ${JSON.stringify(name)}: allowed pattern is [a-zA-Z0-9][a-zA-Z0-9_-]*`
	}
	return undefined
}

/**
 * Extract `--env <name>` / `--env=<name>` from a raw argv. Stops at the
 * `--` separator so a prompt that literally contains `--env …` is never
 * mistaken for a selection. Returns "" when the flag is present without a
 * usable value (so the caller can fail with a clear error), undefined when
 * the flag is absent.
 */
export function extractEnvFlag(rawArgv: string[]): string | undefined {
	for (let i = 0; i < rawArgv.length; i++) {
		const arg = rawArgv[i]
		if (arg === "--") return undefined
		if (arg === "--env") {
			const value = rawArgv[i + 1]
			return value !== undefined && !value.startsWith("-") ? value : ""
		}
		if (arg.startsWith("--env=")) return arg.slice("--env=".length)
	}
	return undefined
}

/**
 * Resolve the active harness environment. Pure with respect to the injected
 * inputs (only the legacy-layout existence probe touches the filesystem).
 * Throws on an invalid requested name — the caller (src/entry.ts) turns that
 * into a startup error.
 */
export function resolveKimchiEnv(input: KimchiEnvResolutionInput): ResolvedKimchiEnv {
	const fromFlag = extractEnvFlag(input.rawArgv)
	const fromVar = input.env.KIMCHI_ENV?.trim()
	const requested = fromFlag ?? (fromVar && fromVar.length > 0 ? fromVar : undefined)
	if (requested !== undefined && requested !== DEFAULT_ENV_NAME) {
		const error = validateEnvName(requested)
		if (error) {
			throw new Error(`${error}. Environments are selected with --env <name> or KIMCHI_ENV.`)
		}
		return { name: requested, root: envsDir(input.home, requested), legacyDefault: false }
	}
	// The default env is the legacy layout used in place when any legacy
	// state exists. The probe accepts ANY entry besides envs/ (config.json,
	// harness/, memory/, daemons/, tags.json, org-policy.json, ferments/, …)
	// so a machine with partial state — not just config.json/harness/ —
	// resolves legacy in place instead of silently orphaning those files
	// under a fresh envs/default.
	const legacyRoot = join(input.home, ".config", "kimchi")
	if (hasLegacyState(legacyRoot)) {
		return { name: DEFAULT_ENV_NAME, root: legacyRoot, legacyDefault: true }
	}
	// No legacy state: the default env gets a fresh tree under envs/.
	return { name: DEFAULT_ENV_NAME, root: envsDir(input.home, DEFAULT_ENV_NAME), legacyDefault: false }
}

/** True when ~/.config/kimchi holds any state besides the envs/ tree and
 *  the machine-global teleport ssh_config (which is written at the legacy
 *  root even on fresh machines and must not flip their default env). */
function hasLegacyState(legacyRoot: string): boolean {
	try {
		return readdirSync(legacyRoot).some((entry) => entry !== "envs" && entry !== "ssh_config")
	} catch {
		return false
	}
}

function envsDir(home: string, name: string): string {
	return join(envsBaseDir(home), name)
}

/** The base directory holding the env trees: `~/.config/kimchi/envs/`. */
export function envsBaseDir(home: string = homedir()): string {
	return join(home, ".config", "kimchi", "envs")
}

/**
 * The env resolved by src/entry.ts for this process, read back from the
 * KIMCHI_ENV_ROOT family of variables it sets. Throws when entry.ts has not
 * run — silently falling back to the legacy layout would split one env's
 * state across two trees, which is exactly the bug this module exists to
 * prevent.
 */
export function readResolvedKimchiEnv(): ResolvedKimchiEnv {
	const root = process.env.KIMCHI_ENV_ROOT
	if (!root) {
		throw new Error(
			"KIMCHI_ENV_ROOT is not set: the harness environment is resolved by src/entry.ts before any config import",
		)
	}
	const name = process.env.KIMCHI_ENV ?? DEFAULT_ENV_NAME
	// Defense in depth: in the packaged binary env-root-init always overwrites
	// KIMCHI_ENV with a validated name, but a process that imports harness
	// modules directly (tests, library use) and sets the pair itself could
	// inject e.g. "../../x" — every consumer joins this name into paths.
	const invalid = validateEnvName(name)
	if (invalid) throw new Error(invalid)
	return {
		name,
		root,
		legacyDefault: process.env.KIMCHI_ENV_LEGACY_DEFAULT === "1",
	}
}

/** Cache base honoring XDG_CACHE_HOME, mirroring src/update/paths.ts. */
function cacheBase(): string {
	const xdg = process.env.XDG_CACHE_HOME
	if (xdg && xdg.length > 0) return xdg
	return join(homedir(), ".cache")
}

/**
 * The active env root for path derivation: KIMCHI_ENV_ROOT (set by
 * src/entry.ts) first, with the legacy top-level layout as fallback. The
 * fallback is identical to pre-environments behavior, so modules imported
 * outside the entry.ts startup path (unit tests, direct imports) keep
 * resolving the same paths as before.
 */
export function envRootOrLegacy(): string {
	return process.env.KIMCHI_ENV_ROOT ?? join(homedir(), ".config", "kimchi")
}

/**
 * The active agent dir (harness home): KIMCHI_CODING_AGENT_DIR (set by
 * src/entry.ts, user-overridable) with an env-root-derived fallback.
 */
export function envAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? join(envRootOrLegacy(), "harness")
}

/**
 * Cache tree for an env: the legacy default keeps `~/.cache/kimchi` (its
 * existing location), env trees under envs/ keep theirs under
 * `~/.cache/kimchi/envs/<name>/`.
 */
export function envCacheDir(resolved: Pick<ResolvedKimchiEnv, "name" | "legacyDefault">): string {
	return resolved.legacyDefault ? join(cacheBase(), "kimchi") : join(cacheBase(), "kimchi", "envs", resolved.name)
}
