/**
 * store.ts — CoordinationStore implementation backed by the filesystem.
 *
 * Each work-item state is a directory under the coordination root.
 * State transitions are atomic renames on the same filesystem.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { v7 as uuidv7 } from "uuid"

import type { CoordinationStore, WorkItem, WorkItemCreateInput, WorkItemState } from "./types.js"
import { WORK_ITEM_STATES } from "./types.js"

export interface CoordinationStoreOptions {
	/**
	 * Root directory for coordination state.
	 *
	 * Defaults to `.kimchi/coordination/` inside the project root detected
	 * from the current working directory, falling back to
	 * `~/.config/kimchi/coordination/`.
	 */
	rootDir?: string
}

// ─── Directory helpers ────────────────────────────────────────────────────────

const STATE_DIRS: Record<WorkItemState, string> = {
	todo: "todo",
	ready: "ready",
	"in-progress": "in-progress",
	blocked: "blocked",
	done: "done",
	archive: "archive",
}

function detectProjectRoot(cwd: string = process.cwd()): string | undefined {
	const { resolve: pathResolve } = require("node:path")
	let current = pathResolve(cwd)
	const stop = pathResolve(current, "/")
	while (current !== stop) {
		if (existsSync(pathResolve(current, ".git"))) return current
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return undefined
}

function resolveCoordinationDir(opts?: CoordinationStoreOptions): string {
	if (opts?.rootDir) return resolve(opts.rootDir)
	const project = detectProjectRoot()
	if (project) return resolve(project, ".kimchi", "coordination")
	return resolve(require("node:os").homedir(), ".config", "kimchi", "coordination")
}

function itemFileName(itemId: string): string {
	return `${itemId}.json`
}

function filePath(dir: string, itemId: string): string {
	return resolve(dir, itemFileName(itemId))
}

function stateDirPath(root: string, state: WorkItemState): string {
	return resolve(root, STATE_DIRS[state])
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function serialize(item: WorkItem): string {
	return `${JSON.stringify(item, null, 2)}\n`
}

function deserialize(raw: string): WorkItem | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"schema_version" in parsed &&
			(parsed as Record<string, unknown>).schema_version === 1 &&
			"id" in parsed &&
			typeof (parsed as Record<string, unknown>).id === "string"
		) {
			return parsed as WorkItem
		}
	} catch {
		// ignore corrupted
	}
	return undefined
}

// ─── CoordinationStore implementation ──────────────────────────────────────────

export class FileSystemCoordinationStore implements CoordinationStore {
	private readonly rootDir: string

	constructor(opts?: CoordinationStoreOptions) {
		this.rootDir = resolveCoordinationDir(opts)
		this.ensureDirs()
	}

	private ensureDirs(): void {
		if (!existsSync(this.rootDir)) {
			mkdirSync(this.rootDir, { recursive: true })
		}
		for (const state of WORK_ITEM_STATES) {
			const d = stateDirPath(this.rootDir, state)
			if (!existsSync(d)) mkdirSync(d, { recursive: true })
		}
	}

	private writeAtomic(dir: string, itemId: string, item: WorkItem): void {
		const dest = filePath(dir, itemId)
		const tmp = `${dest}.${process.pid}.tmp`
		mkdirSync(dirname(dest), { recursive: true })
		writeFileSync(tmp, serialize(item), "utf-8")
		renameSync(tmp, dest)
	}

	private readItem(dir: string, itemId: string): WorkItem | undefined {
		const path = filePath(dir, itemId)
		if (!existsSync(path)) return undefined
		try {
			return deserialize(readFileSync(path, "utf-8"))
		} catch {
			return undefined
		}
	}

	private scanState(state: WorkItemState): WorkItem[] {
		const dir = stateDirPath(this.rootDir, state)
		if (!existsSync(dir)) return []
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
		const items: WorkItem[] = []
		for (const file of files) {
			try {
				const raw = readFileSync(resolve(dir, file), "utf-8")
				const item = deserialize(raw)
				if (item) items.push(item)
			} catch {
				// skip corrupted
			}
		}
		return items
	}

	/**
	 * Return the directory path containing a given item id (if any).
	 */
	private locate(itemId: string): { state: WorkItemState; dir: string } | undefined {
		for (const state of WORK_ITEM_STATES) {
			const dir = stateDirPath(this.rootDir, state)
			if (existsSync(filePath(dir, itemId))) {
				return { state, dir }
			}
		}
		return undefined
	}

	// ─── Public API ──────────────────────────────────────────────────────────────

	getDir(): string {
		return this.rootDir
	}

	create(input: WorkItemCreateInput): WorkItem {
		const now = new Date().toISOString()
		const item: WorkItem = {
			schema_version: 1,
			id: `wi_${uuidv7()}`,
			title: input.title,
			body: input.body,
			ferment_id: input.ferment_id,
			phase_id: input.phase_id,
			agent_role: input.agent_role,
			parents: input.parents ?? [],
			created_at: now,
			updated_at: now,
		}
		const dir = stateDirPath(this.rootDir, "todo")
		this.writeAtomic(dir, item.id, item)
		return item
	}

	claim(itemId: string, agentId: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found || found.state !== "ready") return undefined

		const item = this.readItem(found.dir, itemId)
		if (!item) return undefined

		const now = new Date().toISOString()
		const updated: WorkItem = {
			...item,
			claimed_by: agentId,
			claimed_at: now,
			updated_at: now,
		}

		const destDir = stateDirPath(this.rootDir, "in-progress")
		this.writeAtomic(destDir, itemId, updated)
		// Remove from old state after successful write (safe because unique id).
		unlinkSync(filePath(found.dir, itemId))
		return updated
	}

	complete(itemId: string, result_summary: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found || found.state !== "in-progress") return undefined

		const item = this.readItem(found.dir, itemId)
		if (!item) return undefined

		const now = new Date().toISOString()
		const updated: WorkItem = {
			...item,
			result_summary,
			updated_at: now,
		}

		const destDir = stateDirPath(this.rootDir, "done")
		this.writeAtomic(destDir, itemId, updated)
		unlinkSync(filePath(found.dir, itemId))
		return updated
	}

	block(itemId: string, reason: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found || found.state !== "in-progress") return undefined

		const item = this.readItem(found.dir, itemId)
		if (!item) return undefined

		const now = new Date().toISOString()
		const updated: WorkItem = {
			...item,
			block_reason: reason,
			updated_at: now,
		}

		const destDir = stateDirPath(this.rootDir, "blocked")
		this.writeAtomic(destDir, itemId, updated)
		unlinkSync(filePath(found.dir, itemId))
		return updated
	}

	unblock(itemId: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found || found.state !== "blocked") return undefined

		const item = this.readItem(found.dir, itemId)
		if (!item) return undefined

		const now = new Date().toISOString()
		const updated: WorkItem = {
			...item,
			block_reason: undefined,
			updated_at: now,
		}

		const destDir = stateDirPath(this.rootDir, "ready")
		this.writeAtomic(destDir, itemId, updated)
		unlinkSync(filePath(found.dir, itemId))
		return updated
	}

	archive(itemId: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found || found.state !== "done") return undefined

		const item = this.readItem(found.dir, itemId)
		if (!item) return undefined

		const now = new Date().toISOString()
		const updated: WorkItem = {
			...item,
			updated_at: now,
		}

		const destDir = stateDirPath(this.rootDir, "archive")
		this.writeAtomic(destDir, itemId, updated)
		unlinkSync(filePath(found.dir, itemId))
		return updated
	}

	delete(itemId: string): boolean {
		const found = this.locate(itemId)
		if (!found) return false
		const path = filePath(found.dir, itemId)
		if (!existsSync(path)) return false
		unlinkSync(path)
		return true
	}

	get(itemId: string): WorkItem | undefined {
		const found = this.locate(itemId)
		if (!found) return undefined
		return this.readItem(found.dir, itemId)
	}

	list(state?: WorkItemState): WorkItem[] {
		if (state) return this.scanState(state)
		const all: WorkItem[] = []
		for (const s of WORK_ITEM_STATES) {
			all.push(...this.scanState(s))
		}
		return all
	}

	promoteReady(): number {
		const todoDir = stateDirPath(this.rootDir, "todo")
		if (!existsSync(todoDir)) return 0
		const files = readdirSync(todoDir).filter((f) => f.endsWith(".json"))
		const doneIds = new Set(this.scanState("done").map((i) => i.id))
		let promoted = 0

		for (const file of files) {
			try {
				const raw = readFileSync(resolve(todoDir, file), "utf-8")
				const item = deserialize(raw)
				if (!item) continue
				const allParentsDone = item.parents.every((pid) => doneIds.has(pid))
				if (allParentsDone) {
					const now = new Date().toISOString()
					const updated: WorkItem = { ...item, updated_at: now }
					const readyDir = stateDirPath(this.rootDir, "ready")
					this.writeAtomic(readyDir, item.id, updated)
					unlinkSync(resolve(todoDir, file))
					promoted++
				}
			} catch {
				// skip corrupted
			}
		}
		return promoted
	}
}
