import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { CaptureOptions, CheckpointRecord } from "./git-store.js"
import { readCheckpointMetadata, storageKey, WorkspaceGitStore, writeCheckpointMetadata } from "./git-store.js"

const execFileAsync = promisify(execFile)
const SHUTDOWN_FLUSH_MS = 10_000

export interface CheckpointStoreOptions {
	cwd: string
	stateDir: string
	sessionId: string
}

async function repositoryRoot(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 10_000,
		windowsHide: true,
	})
	return stdout.trim()
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`workspace checkpoint flush exceeded ${ms}ms`)), ms)
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

/** Owns one session's checkpoint queue and metadata. */
export class CheckpointStore {
	private readonly ids: string[] = []
	private readonly records = new Map<string, CheckpointRecord>()
	private sequence = 0
	private tail: Promise<unknown> = Promise.resolve()
	private stopped = false

	private constructor(
		private readonly git: WorkspaceGitStore,
		private readonly metadataDir: string,
	) {}

	static async open(options: CheckpointStoreOptions): Promise<CheckpointStore> {
		const root = await realpath(await repositoryRoot(options.cwd))
		const key = storageKey(root, options.sessionId)
		const stateDir = join(options.stateDir, key)
		const store = new CheckpointStore(
			await WorkspaceGitStore.open(root, join(stateDir, "repo.git")),
			join(stateDir, "checkpoints"),
		)
		for (const record of await readCheckpointMetadata(store.metadataDir)) {
			store.ids.push(record.id)
			store.records.set(record.id, record)
		}
		return store
	}

	get root(): string {
		return this.git.root
	}

	get checkpointIds(): readonly string[] {
		return this.ids
	}

	async get(id: string): Promise<CheckpointRecord | undefined> {
		return this.records.get(id)
	}

	list(): CheckpointRecord[] {
		return this.ids
			.map((id) => this.records.get(id))
			.filter((record): record is CheckpointRecord => record !== undefined)
	}

	capture(options: CaptureOptions): Promise<CheckpointRecord> {
		if (this.stopped) return Promise.reject(new Error("Session checkpoint store is closed"))
		const sequence = ++this.sequence
		const job = this.tail.then(async () => {
			const latest = this.list().at(-1)
			if (options.deduplicate !== false && sequence < this.sequence && latest) {
				return { ...latest, deduplicatedFrom: latest.id }
			}
			const result = await this.git.commit(options)
			if (result.unchanged) {
				const current = this.records.get(result.id)
				return current ? { ...current, deduplicatedFrom: result.id } : result
			}
			await writeCheckpointMetadata(this.metadataDir, result)
			if (!this.ids.includes(result.id)) this.ids.push(result.id)
			this.records.set(result.id, result)
			return result
		})
		this.tail = job.then(
			() => undefined,
			(error: unknown) => {
				console.error("workspace-checkpoints: capture failed:", error)
			},
		)
		return job
	}

	async restore(
		id: string,
	): Promise<{ checkpoint: CheckpointRecord; safetyCheckpoint: CheckpointRecord; restoredPaths: number }> {
		const checkpoint = this.records.get(id)
		if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`)
		const safetyCheckpoint = await this.capture({
			trigger: "before-restore",
			label: "Before restore",
			deduplicate: false,
		})
		const { branch } = await this.git.branchState()
		if (branch !== checkpoint.branch)
			throw new Error(`Cannot restore checkpoint from ${checkpoint.branch} while on ${branch}`)
		const restoredPaths = await this.git.restore(id)
		return { checkpoint, safetyCheckpoint, restoredPaths }
	}

	/** Stop accepting captures and wait only for this store's own queue. */
	async shutdown(timeoutMs = SHUTDOWN_FLUSH_MS): Promise<boolean> {
		this.stopped = true
		try {
			await withTimeout(this.tail, timeoutMs)
			return true
		} catch (error) {
			console.error("workspace-checkpoints: shutdown flush failed:", error)
			return false
		}
	}
}
