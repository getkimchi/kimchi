/**
 * Harness-local profile resolution.
 *
 * A profile is a self-contained kimchi state tree — config, logins, sessions,
 * memory, skills — rooted at one directory:
 *
 *   - the default profile is `~/.config/kimchi/` itself, for everyone:
 *     old users, new users, no exceptions;
 *   - any other profile lives at `~/.config/kimchi/profiles/<name>/`.
 *
 * Selection: `--profile <name>` (highest precedence) or `KIMCHI_PROFILE`.
 * The name `default` always resolves to the default profile, so
 * `--profile default` is exactly equivalent to passing nothing.
 *
 * Import constraint: this module must stay free of pi-mono transitive imports
 * (node builtins only) because src/entry.ts imports it statically before
 * PI_PACKAGE_DIR is set — src/entry-import-graph.test.ts enforces this.
 */

import { homedir } from "node:os"
import { join } from "node:path"

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MAX_PROFILE_NAME_LENGTH = 32

/** The name of the default profile (rooted at ~/.config/kimchi itself). */
export const DEFAULT_PROFILE_NAME = "default"

export interface ResolvedKimchiProfile {
	/** Profile name; `default` for the default profile. */
	name: string
	/** Directory holding this profile's state tree (config.json, harness/, ...). */
	root: string
	/** True for the default profile (root at ~/.config/kimchi, shared cache). */
	defaultProfile: boolean
}

/** Inputs `resolveKimchiProfile` needs; every path source is injected so the
 *  resolution matrix is unit-testable without touching the real home. */
export interface KimchiProfileResolutionInput {
	rawArgv: string[]
	env: NodeJS.ProcessEnv
	home: string
}

/**
 * Validate a profile name. Returns an error message when invalid, undefined
 * when valid. Strict allowlist blocks path traversal (`..`, separators, NUL)
 * and case/typo drift before any path is derived.
 */
export function validateProfileName(name: string): string | undefined {
	if (name.length === 0) return "profile name must not be empty"
	if (name.length > MAX_PROFILE_NAME_LENGTH) {
		return `profile name is longer than ${MAX_PROFILE_NAME_LENGTH} characters: ${JSON.stringify(name)}`
	}
	if (!PROFILE_NAME_PATTERN.test(name)) {
		return `invalid profile name ${JSON.stringify(name)}: allowed pattern is [a-zA-Z0-9][a-zA-Z0-9_-]*`
	}
	return undefined
}

/**
 * Extract `--profile <name>` / `--profile=<name>` from a raw argv. Stops at
 * the `--` separator so a prompt that literally contains `--profile …` is
 * never mistaken for a selection. Returns "" when the flag is present
 * without a usable value (so the caller can fail with a clear error),
 * undefined when the flag is absent.
 */
export function extractProfileFlag(rawArgv: string[]): string | undefined {
	for (let i = 0; i < rawArgv.length; i++) {
		const arg = rawArgv[i]
		if (arg === "--") return undefined
		if (arg === "--profile") {
			const value = rawArgv[i + 1]
			return value !== undefined && !value.startsWith("-") ? value : ""
		}
		if (arg.startsWith("--profile=")) return arg.slice("--profile=".length)
	}
	return undefined
}

/**
 * Resolve the active harness profile. Pure with respect to the injected
 * inputs — no filesystem probing: the default profile is ALWAYS
 * `~/.config/kimchi`, for fresh machines and long-standing ones alike.
 * Throws on an invalid requested name — the caller (src/entry.ts) turns
 * that into a startup error.
 */
export function resolveKimchiProfile(input: KimchiProfileResolutionInput): ResolvedKimchiProfile {
	const fromFlag = extractProfileFlag(input.rawArgv)
	const fromVar = input.env.KIMCHI_PROFILE?.trim()
	const requested = fromFlag ?? (fromVar && fromVar.length > 0 ? fromVar : undefined)
	if (requested !== undefined && requested !== DEFAULT_PROFILE_NAME) {
		const error = validateProfileName(requested)
		if (error) {
			throw new Error(`${error}. Profiles are selected with --profile <name> or KIMCHI_PROFILE.`)
		}
		return { name: requested, root: profilesDir(input.home, requested), defaultProfile: false }
	}
	// The default profile is the top-level layout, used in place — for
	// existing users and fresh machines alike. Nothing moves, nothing
	// migrates, and no probe decides anything.
	return { name: DEFAULT_PROFILE_NAME, root: join(input.home, ".config", "kimchi"), defaultProfile: true }
}

function profilesDir(home: string, name: string): string {
	return join(profilesBaseDir(home), name)
}

/** The base directory holding the named profile trees: `~/.config/kimchi/profiles/`. */
export function profilesBaseDir(home: string = homedir()): string {
	return join(home, ".config", "kimchi", "profiles")
}

/**
 * The profile resolved by src/entry.ts for this process, read back from the
 * KIMCHI_PROFILE_ROOT family of variables it sets. Throws when entry.ts has
 * not run — silently falling back to the default profile would split one
 * profile's state across two trees, which is exactly the bug this module
 * exists to prevent.
 */
export function readResolvedKimchiProfile(): ResolvedKimchiProfile {
	const root = process.env.KIMCHI_PROFILE_ROOT
	if (!root) {
		throw new Error(
			"KIMCHI_PROFILE_ROOT is not set: the harness profile is resolved by src/entry.ts before any config import",
		)
	}
	const name = process.env.KIMCHI_PROFILE ?? DEFAULT_PROFILE_NAME
	// Defense in depth: in the packaged binary profile-root-init always
	// overwrites KIMCHI_PROFILE with a validated name, but a process that
	// imports harness modules directly (tests, library use) and sets the
	// pair itself could inject e.g. "../../x" — every consumer joins this
	// name into paths.
	const invalid = validateProfileName(name)
	if (invalid) throw new Error(invalid)
	return {
		name,
		root,
		defaultProfile: process.env.KIMCHI_PROFILE_DEFAULT === "1",
	}
}

/** Cache base honoring XDG_CACHE_HOME, mirroring src/update/paths.ts. */
function cacheBase(): string {
	const xdg = process.env.XDG_CACHE_HOME
	if (xdg && xdg.length > 0) return xdg
	return join(homedir(), ".cache")
}

/**
 * The active profile root for path derivation: KIMCHI_PROFILE_ROOT (set by
 * src/entry.ts) first, with the top-level layout as fallback. The fallback
 * is the default profile's own root, so modules imported outside the
 * entry.ts startup path (unit tests, direct imports) resolve the same
 * paths as a default-profile launch.
 */
export function profileRoot(): string {
	return process.env.KIMCHI_PROFILE_ROOT ?? join(homedir(), ".config", "kimchi")
}

/**
 * The active agent dir (harness home): KIMCHI_CODING_AGENT_DIR (set by
 * src/entry.ts) with a profile-root-derived fallback.
 */
export function profileAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? join(profileRoot(), "harness")
}

/**
 * Cache tree for a profile: the default profile keeps `~/.cache/kimchi` (its
 * existing location), named profiles keep theirs under
 * `~/.cache/kimchi/profiles/<name>/`.
 */
export function profileCacheDir(resolved: Pick<ResolvedKimchiProfile, "name" | "defaultProfile">): string {
	return resolved.defaultProfile ? join(cacheBase(), "kimchi") : join(cacheBase(), "kimchi", "profiles", resolved.name)
}
