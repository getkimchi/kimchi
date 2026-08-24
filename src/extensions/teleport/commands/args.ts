export interface TeleportArgs {
	name?: string
	workspace?: string
	allowDirty?: boolean
	force?: boolean
	gitRepo?: string
	branch?: string
	noGitToken?: boolean
	noCompactHint?: boolean
	skipSession?: boolean
}

const SESSION_NAME_RE = /^[A-Za-z0-9\-_]+$/

/**
 * Single source of truth for /teleport flag metadata. The parser derives its
 * value/boolean `Set`s from this array, and the autocomplete function reads the
 * descriptions from it — so a new flag added here is immediately parsed and
 * surfaced in the completion picker without touching a second location.
 */
export interface TeleportFlag {
	/** Long form, e.g. "--allow-dirty". */
	name: string
	/** True for flags that take a value (`--workspace <id>`), false for booleans. */
	takesValue: boolean
	/** Short description shown in the autocomplete picker. */
	description: string
}

export const TELEPORT_FLAGS: readonly TeleportFlag[] = [
	{ name: "--workspace", takesValue: true, description: "Reuse an existing workspace (id or name)" },
	{ name: "--git-repo", takesValue: true, description: "Clone from a git URL instead of rsyncing local files" },
	{ name: "--branch", takesValue: true, description: "Branch to check out (requires --git-repo)" },
	{ name: "--allow-dirty", takesValue: false, description: "Proceed with uncommitted changes" },
	{ name: "--force", takesValue: false, description: "Override the 5 GB workspace size limit" },
	{ name: "--no-git-token", takesValue: false, description: "Skip the git credentials prompt" },
	{ name: "--no-compact-hint", takesValue: false, description: "Skip the pre-teleport compaction hint" },
	{
		name: "--skip-session",
		takesValue: false,
		description: "Start remote agent fresh without uploading session history",
	},
]

const FLAGS_WITH_VALUE = new Set(TELEPORT_FLAGS.filter((f) => f.takesValue).map((f) => f.name))
const BOOLEAN_FLAGS = new Set(TELEPORT_FLAGS.filter((f) => !f.takesValue).map((f) => f.name))

/** Completion item returned by `getTeleportArgumentCompletions`. */
export interface TeleportCompletion {
	value: string
	label: string
	description?: string
}

/**
 * Shown on an empty prefix (right after `/teleport `) so users immediately
 * discover the positional session name and the two most common flags without
 * having to type `--`. Once the user starts typing, these fall away and the
 * standard dash-prefix flag filtering takes over.
 */
const TELEPORT_DISCOVERY_COMPLETIONS: readonly TeleportCompletion[] = [
	{ value: "my-feature", label: "my-feature", description: "Sample session name (or type your own)" },
	{ value: "--allow-dirty", label: "--allow-dirty", description: "Proceed with uncommitted changes" },
	{ value: "--force", label: "--force", description: "Override the 5 GB workspace size limit" },
]

/**
 * Suggest `/teleport` completions for the autocomplete picker.
 *
 * Three behaviors:
 * 1. **Empty prefix** (`/teleport `) — returns only the three discovery
 *    items (`my-feature`, `--allow-dirty`, `--force`) so users learn the most
 *    common forms exist without being overwhelmed.
 * 2. **Dash prefix** (`--<partial>`) — filters all 8 flags by case-insensitive
 *    prefix. Value flags emit a trailing space so the cursor lands inside the
 *    argument, mirroring `/ferment`'s `"switch "` / `"revise "` completions.
 * 3. **Non-dash, non-empty** — returns all flags unfiltered so they're
 *    discoverable while the user types a session name.
 */
export function getTeleportArgumentCompletions(prefix: string): TeleportCompletion[] | null {
	const trimmed = prefix.trimStart()
	if (trimmed === "") return [...TELEPORT_DISCOVERY_COMPLETIONS]

	const allFlags: TeleportCompletion[] = TELEPORT_FLAGS.map((f) => ({
		value: f.takesValue ? `${f.name} ` : f.name,
		label: f.name,
		description: f.description,
	}))

	if (!trimmed.startsWith("-")) return allFlags

	const lower = trimmed.toLowerCase()
	const matches = allFlags.filter((f) => f.label.toLowerCase().startsWith(lower))
	return matches.length > 0 ? matches : null
}

/**
 * Parse `/teleport [name] [--workspace ID] [--git-repo URL] [--branch B]
 *                  [--allow-dirty] [--force] [--no-git-token] [--no-compact-hint]
 *                  [--skip-session]`.
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
			if (flag === "--no-compact-hint") {
				args.noCompactHint = true
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
	workspace: string
	source: string
	target: string
	exclude: string[]
	includeIgnored: boolean
	/** When true, extraneous files at the destination are deleted. Default: false. */
	delete: boolean
	dryRun: boolean
}

/**
 * Parse `/sync up|down --workspace <ref> --source <path> --target <path>
 *                     [--exclude GLOB]… [--include-ignored]
 *                     [--delete | --no-delete] [--dry-run]`.
 *
 * Direction (`up` or `down`) is the only positional and is required. The
 * three flags `--workspace`, `--source`, `--target` are all mandatory.
 *
 * For `up`, `--source` is local and `--target` is remote.
 * For `down`, `--source` is remote and `--target` is local.
 */
export function parseSyncArgs(raw: string): SyncArgs {
	const tokens = tokenize(raw)
	let direction: SyncDirection | undefined
	let workspace: string | undefined
	let source: string | undefined
	let target: string | undefined
	const exclude: string[] = []
	let includeIgnored = false
	let deleteExtraneous = false
	let dryRun = false

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as string
		if (t === "--") {
			throw new Error("Unexpected `--` in /sync arguments")
		}
		if (!t.startsWith("--")) {
			if (direction !== undefined) {
				throw new Error(`Unexpected positional argument: ${t}`)
			}
			if (t !== "up" && t !== "down") {
				throw new Error(`Direction must be "up" or "down" (got "${t}")`)
			}
			direction = t
			continue
		}
		const eqIdx = t.indexOf("=")
		const flag = eqIdx === -1 ? t : t.slice(0, eqIdx)
		let value: string | undefined
		if (eqIdx !== -1) value = t.slice(eqIdx + 1)

		switch (flag) {
			case "--include-ignored":
				includeIgnored = true
				continue
			case "--delete":
				deleteExtraneous = true
				continue
			case "--no-delete":
				deleteExtraneous = false
				continue
			case "--dry-run":
				dryRun = true
				continue
			case "--exclude": {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error("--exclude requires a glob argument")
					}
					i++
				}
				exclude.push(value)
				continue
			}
			case "--workspace":
			case "--source":
			case "--target": {
				if (value === undefined) {
					value = tokens[i + 1]
					if (value === undefined || value.startsWith("--")) {
						throw new Error(`${flag} requires a value`)
					}
					i++
				}
				if (value.length === 0) throw new Error(`${flag} requires a non-empty value`)
				if (flag === "--workspace") workspace = value
				else if (flag === "--source") source = value
				else target = value
				continue
			}
			default:
				throw new Error(`Unknown flag: ${flag}`)
		}
	}

	if (direction === undefined) {
		throw new Error("Missing direction. Usage: /sync up|down --workspace <ref> --source <path> --target <path>")
	}
	const missing: string[] = []
	if (workspace === undefined) missing.push("--workspace")
	if (source === undefined) missing.push("--source")
	if (target === undefined) missing.push("--target")
	if (missing.length > 0) {
		throw new Error(`Missing required flag(s): ${missing.join(", ")}`)
	}

	return {
		direction,
		workspace: workspace as string,
		source: source as string,
		target: target as string,
		exclude,
		includeIgnored,
		delete: deleteExtraneous,
		dryRun,
	}
}
