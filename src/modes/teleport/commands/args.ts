export interface TeleportArgs {
	name?: string
	allowDirty: boolean
	exclude: string[]
	includeIgnored: boolean
	abandonPending: boolean
	force: boolean
	skipSession?: boolean
	noGitToken?: boolean
}

export interface DetachArgs {
	abandonPending: boolean
}

export interface AttachArgs {
	target: string
}

export interface ConnectArgs {
	target?: string
}

export class TeleportArgsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TeleportArgsError"
	}
}

function tokenize(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean)
}

export function parseTeleportArgs(raw: string): TeleportArgs {
	const tokens = tokenize(raw)
	const result: TeleportArgs = {
		allowDirty: false,
		exclude: [],
		includeIgnored: false,
		abandonPending: false,
		force: false,
		skipSession: false,
		noGitToken: false,
	}
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		switch (t) {
			case "--allow-dirty":
				result.allowDirty = true
				break
			case "--include-ignored":
				result.includeIgnored = true
				break
			case "--abandon-pending":
				result.abandonPending = true
				break
			case "--force":
				result.force = true
				break
			case "--skip-session":
				result.skipSession = true
				break
			case "--no-git-token":
				result.noGitToken = true
				break
			case "--exclude": {
				const next = tokens[i + 1]
				if (!next || next.startsWith("--")) {
					throw new TeleportArgsError("--exclude requires a glob argument")
				}
				result.exclude.push(next)
				i++
				break
			}
			default:
				if (t.startsWith("--")) {
					throw new TeleportArgsError(`Unknown flag: ${t}`)
				}
				if (result.name !== undefined) {
					throw new TeleportArgsError(`Unexpected positional argument: ${t}`)
				}
				result.name = t
		}
	}
	return result
}

export function parseDetachArgs(raw: string): DetachArgs {
	const tokens = tokenize(raw)
	const result: DetachArgs = { abandonPending: false }
	for (const t of tokens) {
		if (t === "--abandon-pending") {
			result.abandonPending = true
		} else {
			throw new TeleportArgsError(`Unknown argument: ${t}`)
		}
	}
	return result
}

export function parseAttachArgs(raw: string): AttachArgs {
	const tokens = tokenize(raw)
	if (tokens.length === 0) {
		throw new TeleportArgsError("Usage: /attach <name-or-id>")
	}
	if (tokens.length > 1) {
		throw new TeleportArgsError(`Expected a single name or id; got ${tokens.length} arguments.`)
	}
	const target = tokens[0]
	if (target.startsWith("--")) {
		throw new TeleportArgsError(`Expected a name or id, got flag: ${target}`)
	}
	return { target }
}

export function parseConnectArgs(raw: string): ConnectArgs {
	const tokens = tokenize(raw)
	if (tokens.length === 0) return {}
	if (tokens.length > 1) {
		throw new TeleportArgsError(`Expected at most one target; got ${tokens.length} arguments.`)
	}
	const target = tokens[0]
	if (target.startsWith("--")) {
		throw new TeleportArgsError(`Expected a name or id, got flag: ${target}`)
	}
	return { target }
}

export type SyncDirection = "up" | "down"

export interface SyncArgs {
	direction: SyncDirection
	/** Optional relative path within the workspace to sync (instead of the entire workspace). */
	path?: string
	exclude: string[]
	includeIgnored: boolean
	/** When true, extraneous files at the destination are deleted. Default: false. */
	delete: boolean
	/** When true, show what would be transferred without actually doing it. */
	dryRun: boolean
}

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
		const t = tokens[i]
		switch (t) {
			case "up":
			case "down":
				if (directionSet) {
					throw new TeleportArgsError(`Direction already set to "${result.direction}"; got "${t}".`)
				}
				result.direction = t
				directionSet = true
				break
			case "--include-ignored":
				result.includeIgnored = true
				break
			case "--delete":
				result.delete = true
				break
			case "--no-delete":
				result.delete = false
				break
			case "--dry-run":
				result.dryRun = true
				break
			case "--exclude": {
				const next = tokens[i + 1]
				if (!next || next.startsWith("--")) {
					throw new TeleportArgsError("--exclude requires a glob argument")
				}
				result.exclude.push(next)
				i++
				break
			}
			case "--path": {
				const next = tokens[i + 1]
				if (!next || next.startsWith("--")) {
					throw new TeleportArgsError("--path requires an argument")
				}
				if (result.path !== undefined) {
					throw new TeleportArgsError("--path specified more than once")
				}
				result.path = next
				i++
				break
			}
			default:
				if (t.startsWith("--")) {
					throw new TeleportArgsError(`Unknown flag: ${t}`)
				}
				// Treat bare positional as a path if direction is already set
				if (directionSet && result.path === undefined) {
					result.path = t
				} else if (!directionSet) {
					throw new TeleportArgsError(
						`Expected "up" or "down" as the first argument; got "${t}". Usage: /sync <up|down> [path] [--flags]`,
					)
				} else {
					throw new TeleportArgsError(`Unexpected positional argument: ${t}`)
				}
		}
	}
	return result
}
