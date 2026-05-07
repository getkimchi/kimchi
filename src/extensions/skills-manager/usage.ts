import { open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { lock } from "proper-lockfile"

const SKILLS_DIR_CACHE = new Map<string, UsageTracker>()

export function getUsageTracker(skillsDir: string): UsageTracker {
	let tracker = SKILLS_DIR_CACHE.get(skillsDir)
	if (!tracker) {
		tracker = new UsageTracker(skillsDir)
		SKILLS_DIR_CACHE.set(skillsDir, tracker)
	}
	return tracker
}

/**
 * Batch update skill states. All updates happen in a single locked transaction.
 */
export async function setStateBatch(changes: { name: string; state: SkillState }[]): Promise<void> {
	if (changes.length === 0) return

	// Derive skillsDir from first change (assumes all changes target same skillsDir)
	// For now, we require a skillsDir to be passed. We'll use a placeholder that
	// gets resolved at runtime by the consumer. Actually, let's make this work
	// by requiring the caller to provide the tracker instance or skillsDir.
	// To keep backward compat, we use a singleton approach based on env or default.
	const skillsDir = process.env.SKILLS_DIR ?? join(process.cwd(), "skills")
	const tracker = new UsageTracker(skillsDir)

	await tracker.setStateBatch(changes)
}

export const STATE_ACTIVE = "active" as const
export const STATE_STALE = "stale" as const
export const STATE_ARCHIVED = "archived" as const
export type SkillState = "active" | "stale" | "archived"

export interface UsageEntry {
	name: string
	agent_created: boolean
	created_at?: string
	use_count: number
	last_used_at?: string
	patch_count: number
	last_patched_at?: string
	state: SkillState
	pinned: boolean
	absorbed_into?: string
}

export interface AgentCreatedSkillReport {
	name: string
	pinned: boolean
	state: SkillState
	created_at?: string
	last_activity_at?: string
}

/**
 * Returns the most recent activity timestamp for a skill.
 * This considers created_at, last_used_at, and last_patched_at.
 */
export function computeLastActivityAt(entry: UsageEntry): string | undefined {
	const timestamps: string[] = []
	if (entry.created_at) timestamps.push(entry.created_at)
	if (entry.last_used_at) timestamps.push(entry.last_used_at)
	if (entry.last_patched_at) timestamps.push(entry.last_patched_at)

	if (timestamps.length === 0) return undefined

	// Return the most recent timestamp
	return timestamps.sort().at(-1)
}

/**
 * Returns all agent-created skills with their relevant fields for auto-transitions.
 */
export async function agentCreatedReport(skillsDir: string): Promise<AgentCreatedSkillReport[]> {
	const usagePath = join(skillsDir, ".usage.json")

	try {
		const raw = await readFile(usagePath, "utf-8")
		if (!raw.trim()) return []

		const obj = JSON.parse(raw) as Record<string, UsageEntry>
		const entries = Object.values(obj)

		return entries
			.filter((entry) => entry.agent_created)
			.map((entry) => ({
				name: entry.name,
				pinned: entry.pinned,
				state: entry.state,
				created_at: entry.created_at,
				last_activity_at: computeLastActivityAt(entry),
			}))
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
			return []
		}
		throw err
	}
}

export class UsageTracker {
	private readonly usagePath: string
	private readonly lockPath: string

	constructor(skillsDir: string) {
		this.usagePath = join(skillsDir, ".usage.json")
		this.lockPath = `${this.usagePath}.lock`
	}

	private async _load(): Promise<Map<string, UsageEntry>> {
		try {
			const raw = await readFile(this.usagePath, "utf-8")
			if (!raw.trim()) return new Map()
			const obj = JSON.parse(raw) as Record<string, UsageEntry>
			return new Map(Object.entries(obj))
		} catch (err: unknown) {
			if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
				return new Map()
			}
			throw err
		}
	}

	private async _save(entries: Map<string, UsageEntry>): Promise<void> {
		const content = JSON.stringify(Object.fromEntries(entries), null, 2)
		const tmpPath = `${this.usagePath}.tmp.${Date.now()}`
		await writeFile(tmpPath, content, "utf-8")
		await rename(tmpPath, this.usagePath)
	}

	private async _lock<T>(fn: (entries: Map<string, UsageEntry>) => T | Promise<T>): Promise<T> {
		// Ensure lock file exists
		await open(this.lockPath, "a").then((fh) => fh.close())

		const release = await lock(this.lockPath, {
			retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1000 },
		})

		try {
			const entries = await this._load()
			const result = await fn(entries)
			await this._save(entries)
			return result
		} finally {
			await release()
		}
	}

	private now(): string {
		return new Date().toISOString()
	}

	private getOrThrow(entries: Map<string, UsageEntry>, name: string): UsageEntry {
		const entry = entries.get(name)
		if (!entry) {
			throw new Error(`Skill "${name}" not found in usage tracker`)
		}
		return entry
	}

	async list(): Promise<UsageEntry[]> {
		const entries = await this._load()
		return Array.from(entries.values())
	}

	async bumpCreate(name: string, agentCreated = false): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry: UsageEntry = {
				name,
				agent_created: agentCreated,
				created_at: this.now(),
				use_count: 0,
				patch_count: 0,
				state: "active",
				pinned: false,
			}
			entries.set(name, entry)
			return entry
		})
	}

	async bumpPatch(name: string): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry = this.getOrThrow(entries, name)
			entry.patch_count += 1
			entry.last_patched_at = this.now()
			return entry
		})
	}

	async setPin(name: string, pin: boolean): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry = this.getOrThrow(entries, name)
			entry.pinned = pin
			return entry
		})
	}

	async archive(name: string, absorbedInto?: string): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry = this.getOrThrow(entries, name)
			entry.state = "archived"
			if (absorbedInto !== undefined) {
				entry.absorbed_into = absorbedInto
			}
			return entry
		})
	}

	async bumpUse(name: string): Promise<void> {
		try {
			await this._lock((entries) => {
				const entry = entries.get(name)
				if (!entry) return
				entry.use_count += 1
				entry.last_used_at = this.now()
			})
		} catch {
			// best-effort — stale detection is non-critical
		}
	}

	async get(name: string): Promise<UsageEntry | undefined> {
		return this._lock((entries) => entries.get(name))
	}

	async setState(name: string, state: SkillState): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry = this.getOrThrow(entries, name)
			entry.state = state
			return entry
		})
	}

	async setStateBatch(changes: { name: string; state: SkillState }[]): Promise<void> {
		if (changes.length === 0) return
		await this._lock((entries) => {
			for (const { name, state } of changes) {
				const entry = this.getOrThrow(entries, name)
				entry.state = state
			}
			// Return value unused
		})
	}
}
