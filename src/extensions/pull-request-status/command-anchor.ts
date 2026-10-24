/**
 * The directory shell commands actually run in, used to anchor the branch and PR/MR status.
 *
 * A session's `cwd` is fixed for its lifetime, so a `git worktree add … && cd <worktree>` workflow
 * would otherwise keep reporting the main checkout's branch. This module observes command
 * directories from shell activity and validates them against the session repository's worktrees,
 * falling back to `cwd` in every other case.
 */
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { command } from "./provider-api.js"

/** Resolve a shell word to an absolute path, or undefined when it cannot be a plain directory. */
function resolveDirectory(token: string, baseCwd: string): string | undefined {
	if (!token || token === "-") return undefined
	// `\u0000` marks a token that held a shell substitution the tokenizer could not resolve.
	if (token.includes("\u0000")) return undefined
	if (/[$`"'\\\n<>?*|&;(){}[\]]/.test(token)) return undefined
	const expanded = token === "~" || token.startsWith("~/") ? join(homedir(), token.slice(1)) : token
	const directory = isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded)
	// macOS and CI scratch directories commonly resolve through symlinked prefixes; resolve the
	// real path so a comparison against worktree paths does not miss.
	return safeRealpath(directory)
}

/** Resolve the real path of an existing path, otherwise the normalized path. */
function safeRealpath(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

/** A short label locating `anchor` from `cwd`: the path relative to the session directory, or the
 *  anchor's basename when it lies outside it. */
export function directoryLabel(cwd: string, anchor: string): string {
	const label = relative(safeRealpath(cwd), anchor)
	return label.startsWith("..") ? basename(anchor) : label
}

/** Split a command into segments separated by `&&`, `||`, `;`, `|` or newlines. */
function commandSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean)
}

/**
 * Tokenize a command segment the way a shell would see it: quoted words stay single tokens and
 * keep no quotes, so `cd "a b"` yields the token `a b`. A substitution (`$(…)`, `$VAR`) makes a
 * token unresolvable without a null marker that survives in place.
 */
function tokenize(segment: string): string[] | undefined {
	const tokens: string[] = []
	let token = ""
	let quoted: '"' | "'" | undefined
	const push = () => {
		if (token.length) tokens.push(token)
		token = ""
	}
	for (let index = 0; index < segment.length; index++) {
		const character = segment[index]
		if (quoted) {
			if (character === quoted) quoted = undefined
			else token += character
			continue
		}
		if (character === '"' || character === "'") {
			quoted = character
			continue
		}
		if (character === "\\") {
			const next = segment[index + 1]
			if (next === undefined) return undefined
			token += next
			index++
			continue
		}
		if (/\s/.test(character)) {
			push()
			continue
		}
		if (character === "$" || character === "`") {
			// A substitution inside a token cannot be resolved; skip to its matching close so its
			// contents are not mistaken for paths, and mark the token unresolvable.
			const close = character === "$" ? (segment[index + 1] === "(" ? ")" : "") : "`"
			if (close) {
				const end = segment.indexOf(close, index + 2)
				if (end === -1) return undefined
				index = end
			}
			token += "\u0000"
			continue
		}
		token += character
	}
	if (quoted) return undefined
	push()
	return tokens
}

/**
 * The absolute directory a command executes in, when that can be read from the command text:
 * a `cd <path>` segment (the last one wins) or `git -C <path>` at a segment start. Substitutions,
 * `cd -` and bare `cd` return undefined: their target cannot be known without running them.
 */
export function observedCommandDirectory(command: string, baseCwd: string): string | undefined {
	let observed: string | undefined
	for (const segment of commandSegments(command)) {
		const tokens = tokenize(segment)
		if (!tokens) return undefined
		const [first, ...rest] = tokens
		if (first === "cd") {
			// `cd` alone goes home, which the parser cannot name; `cd -` and `cd a b` are invalid.
			if (rest.length !== 1) return undefined
			const resolved = resolveDirectory(rest[0], baseCwd)
			if (resolved) observed = resolved
			continue
		}
		if (first !== "git") continue
		// Leading global flags such as `--no-pager` are allowed before `-C`; `-c <config>` consumes its value.
		let index = 0
		for (; index < rest.length; index++) {
			const token = rest[index]
			if (token === "-c") index++
			else if (/^-C/.test(token) || !token.startsWith("-")) break
		}
		if (index >= rest.length) continue
		const flag = rest[index]
		const value = /^-C$/.test(flag) ? rest[index + 1] : /^-C.+/.test(flag) ? flag.slice(2) : undefined
		if (value === undefined) continue
		const resolved = resolveDirectory(value, baseCwd)
		if (resolved) observed = resolved
	}
	return observed
}

/**
 * The directory to anchor the branch and PR/MR lookup on: the observed command directory when
 * it lies inside or equal to one of the session repository's worktrees, otherwise `cwd`. Every
 * failure, including timeouts and a missing observed path, falls back to `cwd` (today's behavior).
 */
export async function anchorDirectory(
	cwd: string,
	observed: string | undefined,
	signal: AbortSignal,
	deadline: number,
): Promise<string> {
	try {
		if (!observed) return cwd
		const observedReal = safeRealpath(observed)
		if (observedReal === safeRealpath(cwd)) return cwd
		if (!isDirectory(observedReal)) return cwd
		const listing = await command(
			"git",
			["-C", cwd, "worktree", "list", "--porcelain", "-z"],
			cwd,
			signal,
			Math.min(deadline, Date.now() + 2000),
		)
		if (!listing) return cwd
		for (const entry of listing.split("\0")) {
			const worktree = /^worktree (.+)$/.exec(entry)?.[1]
			const root = worktree ? safeRealpath(worktree) : undefined
			// A linked worktree can only report its root, so containment covers a nested observation.
			if (root && (observedReal === root || observedReal.startsWith(`${root}/`))) return observed
		}
	} catch {
		// Fail open to the session's own directory.
	}
	return cwd
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}
