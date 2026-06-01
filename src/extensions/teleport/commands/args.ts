export interface TeleportArgs {
	name?: string
	workspace?: string
	allowDirty?: boolean
	force?: boolean
	gitRepo?: string
	branch?: string
	noGitToken?: boolean
	skipSession?: boolean
}

const SESSION_NAME_RE = /^[A-Za-z0-9\-_]+$/

const FLAGS_WITH_VALUE = new Set(["--workspace", "--git-repo", "--branch"])
const BOOLEAN_FLAGS = new Set(["--no-git-token", "--skip-session"])

/**
 * Parse `/teleport [name] [--workspace ID] [--git-repo URL] [--branch B]
 *                  [--allow-dirty] [--force] [--no-git-token] [--skip-session]`.
 *
 * A malformed input (a `--flag=` with no key, a stray `--`) throws so the
 * command surfaces a clear refusal.
 */
export function parseTeleportArgs(raw: string): TeleportArgs {
	const tokens = tokenize(raw)
	const args: TeleportArgs = {}
	let positionalConsumed = false

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as string
		if (t === "--") {
			throw new Error("Unexpected `--` in /teleport arguments")
		}
		if (t.startsWith("--")) {
			const eqIdx = t.indexOf("=")
			const flag = eqIdx === -1 ? t : t.slice(0, eqIdx)
			let value: string | undefined
			if (eqIdx !== -1) {
				value = t.slice(eqIdx + 1)
			}
			if (FLAGS_WITH_VALUE.has(flag)) {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error(`Flag ${flag} requires a value`)
					}
					i++
				}
				if (flag === "--workspace") {
					args.workspace = value
				} else if (flag === "--git-repo") {
					args.gitRepo = value
				} else if (flag === "--branch") {
					args.branch = value
				}
				continue
			}
			if (flag === "--allow-dirty") {
				args.allowDirty = true
				continue
			}
			if (flag === "--force") {
				args.force = true
				continue
			}
			if (flag === "--no-git-token") {
				args.noGitToken = true
				continue
			}
			if (flag === "--skip-session") {
				args.skipSession = true
				continue
			}
			if (BOOLEAN_FLAGS.has(flag)) {
				continue
			}
			throw new Error(`Unknown flag: ${flag}`)
		}
		if (!positionalConsumed) {
			args.name = t
			positionalConsumed = true
			continue
		}
		throw new Error(`Unexpected positional argument: ${t}`)
	}

	if (args.name !== undefined && !SESSION_NAME_RE.test(args.name)) {
		throw new Error(`Invalid session name "${args.name}". Allowed characters: letters, digits, "-", "_".`)
	}
	if (args.workspace !== undefined && args.workspace.length === 0) {
		throw new Error("--workspace requires a non-empty value")
	}

	return args
}

function tokenize(raw: string): string[] {
	return raw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0)
}

export type SyncDirection = "up" | "down"

export interface SyncArgs {
	direction: SyncDirection
	path?: string
	workspace?: string
	exclude: string[]
	includeIgnored: boolean
	/** When true, extraneous files at the destination are deleted. Default: false. */
	delete: boolean
	dryRun: boolean
}

/**
 * Parse `/sync [up|down] [path] [--workspace ID] [--exclude GLOB]
 *               [--include-ignored] [--delete] [--no-delete] [--dry-run] [--path PATH]`.
 *
 * The first positional is treated as the direction (defaults to "up"); a
 * second positional is treated as the relative `path`. Either can also be
 * passed explicitly via `--path`.
 */
export function parseSyncArgs(raw: string): SyncArgs {
	const tokens = tokenize(raw)
	const result: SyncArgs = {
		direction: "up",
		exclude: [],
		includeIgnored: false,
		delete: false,
		dryRun: false,
	}

	let directionSet = false
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as string
		if (t === "--") {
			throw new Error("Unexpected `--` in /sync arguments")
		}
		if (!t.startsWith("--")) {
			if (!directionSet && (t === "up" || t === "down")) {
				result.direction = t
				directionSet = true
				continue
			}
			if (result.path === undefined) {
				result.path = t
				// First positional is treated as path when it's not up/down;
				// from here on we've effectively consumed the direction slot.
				directionSet = true
				continue
			}
			throw new Error(`Unexpected positional argument: ${t}`)
		}
		const eqIdx = t.indexOf("=")
		const flag = eqIdx === -1 ? t : t.slice(0, eqIdx)
		let value: string | undefined
		if (eqIdx !== -1) value = t.slice(eqIdx + 1)

		switch (flag) {
			case "--include-ignored":
				result.includeIgnored = true
				continue
			case "--delete":
				result.delete = true
				continue
			case "--no-delete":
				result.delete = false
				continue
			case "--dry-run":
				result.dryRun = true
				continue
			case "--exclude": {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error("--exclude requires a glob argument")
					}
					i++
				}
				result.exclude.push(value)
				continue
			}
			case "--path": {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error("--path requires an argument")
					}
					i++
				}
				if (result.path !== undefined) throw new Error("--path specified more than once")
				result.path = value
				continue
			}
			case "--workspace": {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error("--workspace requires a value")
					}
					i++
				}
				if (value.length === 0) throw new Error("--workspace requires a non-empty value")
				result.workspace = value
				continue
			}
			default:
				throw new Error(`Unknown flag: ${flag}`)
		}
	}

	return result
}
