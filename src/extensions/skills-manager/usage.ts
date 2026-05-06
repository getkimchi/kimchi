import { open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { lock } from "proper-lockfile"

export interface UsageEntry {
	name: string
	agent_created: boolean
	created_at?: string
	use_count: number
	last_used_at?: string
	patch_count: number
	last_patched_at?: string
	state: "active" | "archived"
	pinned: boolean
	absorbed_into?: string
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
			const obj = JSON.parse(raw) as Record<string, UsageEntry>
			return new Map(Object.entries(obj))
		} catch (err: unknown) {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") {
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

	async bumpCreate(name: string): Promise<UsageEntry> {
		return this._lock((entries) => {
			const entry: UsageEntry = {
				name,
				agent_created: true,
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

	async get(name: string): Promise<UsageEntry | undefined> {
		return this._lock((entries) => entries.get(name))
	}
}
