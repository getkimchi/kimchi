export interface TeleportArgs {
	name?: string
	allowDirty: boolean
	exclude: string[]
	includeIgnored: boolean
	abandonPending: boolean
	force: boolean
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
