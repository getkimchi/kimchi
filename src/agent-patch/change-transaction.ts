import { createHash, randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent"
import type {
	ApplyReceipt,
	BaseConflict,
	BaseSnapshot,
	BaseVerification,
	ChangeOperation,
	ChangeSet,
	ChangeTransactionState,
} from "./types.js"

interface InternalBaseSnapshot extends BaseSnapshot {
	absolutePath: string
	content?: string
}

interface OverlayEntry {
	content: string | null
	mode?: number
}

interface DesiredFile {
	content: string
	mode: number
}

interface ApplyEntry {
	path: string
	absolutePath: string
	desired?: DesiredFile
	stagedPath?: string
	backupPath?: string
	installed?: boolean
}

interface ApplyJournal {
	entries: ApplyEntry[]
	createdDirectories: string[]
	patchSha256: string
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST"
}

function missingFile(path: string): Error {
	return Object.assign(new Error(`No such file in candidate workspace: ${path}`), { code: "ENOENT" })
}

function normalizeMode(mode: number): number {
	return mode & 0o7777
}

function lineStats(patch: string): { addedLines: number; removedLines: number } {
	let addedLines = 0
	let removedLines = 0
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines++
		if (line.startsWith("-") && !line.startsWith("---")) removedLines++
	}
	return { addedLines, removedLines }
}

export class ChangeTransaction {
	readonly id = randomUUID()
	readonly root: string
	state: ChangeTransactionState = "exploring"

	private readonly base = new Map<string, InternalBaseSnapshot>()
	private readonly overlay = new Map<string, OverlayEntry>()
	private readonly renameOrigins = new Map<string, string>()
	private readonly caseInsensitiveDirectories = new Map<string, Promise<boolean>>()
	private acceptedPatchSha256?: string
	private journal?: ApplyJournal

	constructor(root: string) {
		this.root = resolve(root)
	}

	get hasChanges(): boolean {
		return this.changeSet().operations.length > 0
	}

	async readBuffer(path: string): Promise<Buffer> {
		const normalized = await this.normalizeAndGuard(path)
		await this.assertNoPathAlias(normalized.path, normalized.absolutePath)
		const entry = this.overlay.get(normalized.path)
		if (entry) {
			if (entry.content === null) throw missingFile(normalized.path)
			return Buffer.from(entry.content, "utf8")
		}
		const snapshot = await this.captureBase(normalized.path, normalized.absolutePath)
		if (!snapshot.exists || snapshot.content === undefined) throw missingFile(normalized.path)
		return Buffer.from(snapshot.content, "utf8")
	}

	async assertAccessible(path: string): Promise<void> {
		await this.readBuffer(path)
	}

	async stageWrite(path: string, content: string, mode?: number): Promise<void> {
		this.assertMutable()
		const normalized = await this.normalizeAndGuard(path)
		await this.assertNoPathAlias(normalized.path, normalized.absolutePath)
		const snapshot = await this.captureBase(normalized.path, normalized.absolutePath)
		const nextMode = normalizeMode(mode ?? snapshot.mode ?? 0o644)
		if (
			snapshot.exists &&
			snapshot.content === content &&
			snapshot.mode === nextMode &&
			!this.renameOrigins.has(normalized.path)
		) {
			this.overlay.delete(normalized.path)
		} else {
			this.overlay.set(normalized.path, { content, mode: nextMode })
		}
		this.state = this.state === "revision" ? "revision" : "staging"
	}

	async stageDelete(path: string): Promise<void> {
		this.assertMutable()
		const normalized = await this.normalizeAndGuard(path)
		const current = await this.readBuffer(normalized.absolutePath)
		if (!current) throw missingFile(normalized.path)
		this.overlay.set(normalized.path, { content: null })
		this.renameOrigins.delete(normalized.path)
		this.state = this.state === "revision" ? "revision" : "staging"
	}

	async stageRename(fromPath: string, toPath: string): Promise<void> {
		this.assertMutable()
		const from = await this.normalizeAndGuard(fromPath)
		const to = await this.normalizeAndGuard(toPath)
		if (from.path === to.path) return
		const content = await this.readBuffer(from.absolutePath)
		await this.captureBase(from.path, from.absolutePath)
		await this.assertNoPathAlias(to.path, to.absolutePath)
		const targetBase = await this.captureBase(to.path, to.absolutePath)
		const targetOverlay = this.overlay.get(to.path)
		if (targetBase.exists || (targetOverlay !== undefined && targetOverlay.content !== null)) {
			throw new Error(`Rename target already exists: ${to.path}`)
		}
		const sourceEntry = this.overlay.get(from.path)
		const sourceBase = this.base.get(from.path)
		const origin = this.renameOrigins.get(from.path) ?? from.path
		this.overlay.set(from.path, { content: null })
		this.overlay.set(to.path, {
			content: content.toString("utf8"),
			mode: sourceEntry?.mode ?? sourceBase?.mode ?? 0o644,
		})
		this.renameOrigins.delete(from.path)
		this.renameOrigins.set(to.path, origin)
		this.state = this.state === "revision" ? "revision" : "staging"
	}

	async validatePath(path: string): Promise<string> {
		const normalized = await this.normalizeAndGuard(path)
		await this.assertNoPathAlias(normalized.path, normalized.absolutePath)
		return normalized.path
	}

	async stageDirectory(path: string): Promise<void> {
		this.assertMutable()
		const absolutePath = resolve(isAbsolute(path) ? path : join(this.root, path))
		if (absolutePath === this.root) return
		await this.normalizeAndGuard(path, true)
	}

	propose(): ChangeSet {
		if (this.state !== "exploring" && this.state !== "staging" && this.state !== "revision") {
			throw new Error(`Cannot propose transaction while ${this.state}`)
		}
		const changeSet = this.changeSet()
		if (changeSet.operations.length === 0) throw new Error("Cannot propose an empty transaction")
		this.state = "proposed"
		return changeSet
	}

	reopenForRevision(expectedPatchSha256: string): void {
		if (this.state !== "proposed") throw new Error(`Cannot revise transaction while ${this.state}`)
		if (this.changeSet().patchSha256 !== expectedPatchSha256) throw new Error("Reviewed patch changed before revision")
		this.acceptedPatchSha256 = undefined
		this.state = "revision"
	}

	accept(expectedPatchSha256: string): void {
		if (this.state !== "proposed") throw new Error(`Cannot accept transaction while ${this.state}`)
		if (this.changeSet().patchSha256 !== expectedPatchSha256)
			throw new Error("Accepted patch hash does not match candidate")
		this.acceptedPatchSha256 = expectedPatchSha256
		this.state = "accepted"
	}

	changeSet(): ChangeSet {
		const operations = this.operations()
		const base = this.relevantBase(operations)
		const patch = this.renderPatch(operations)
		const patchSha256 = sha256(patch)
		const { addedLines, removedLines } = lineStats(patch)
		return {
			transactionId: this.id,
			operations,
			base,
			patch,
			patchSha256,
			stats: {
				files: new Set(
					operations.flatMap((operation) =>
						operation.kind === "rename" ? [operation.fromPath, operation.path] : [operation.path],
					),
				).size,
				addedLines,
				removedLines,
				patchBytes: Buffer.byteLength(patch),
			},
		}
	}

	async verifyBase(): Promise<BaseVerification> {
		const conflicts: BaseConflict[] = []
		const changeSet = this.changeSet()
		for (const snapshot of this.internalRelevantBase(changeSet.operations)) {
			try {
				await this.normalizeAndGuard(snapshot.absolutePath)
			} catch {
				conflicts.push({ path: snapshot.path, reason: "unsafe_path" })
				continue
			}
			try {
				const stat = await lstat(snapshot.absolutePath)
				if (!snapshot.exists) {
					conflicts.push({ path: snapshot.path, reason: "appeared" })
					continue
				}
				if (!stat.isFile() || stat.isSymbolicLink()) {
					conflicts.push({ path: snapshot.path, reason: "content_changed" })
					continue
				}
				const current = await readFile(snapshot.absolutePath)
				if (sha256(current) !== snapshot.sha256) {
					conflicts.push({ path: snapshot.path, reason: "content_changed" })
					continue
				}
				if (normalizeMode(stat.mode) !== snapshot.mode) {
					conflicts.push({ path: snapshot.path, reason: "mode_changed" })
				}
			} catch (error) {
				if (isMissing(error) && snapshot.exists) conflicts.push({ path: snapshot.path, reason: "missing" })
				else if (!isMissing(error)) conflicts.push({ path: snapshot.path, reason: "unsafe_path" })
			}
		}
		return { ok: conflicts.length === 0, conflicts }
	}

	async applyExact(expectedPatchSha256: string): Promise<ApplyReceipt> {
		if (this.state !== "accepted") throw new Error(`Cannot apply transaction while ${this.state}`)
		if (this.acceptedPatchSha256 !== expectedPatchSha256 || this.changeSet().patchSha256 !== expectedPatchSha256) {
			throw new Error("Patch changed after acceptance")
		}
		this.state = "base_verification"
		try {
			await this.assertNoAliases(this.internalRelevantBase(this.changeSet().operations))
		} catch (error) {
			this.state = "failed"
			throw error
		}
		const verification = await this.verifyBase()
		if (!verification.ok) {
			this.state = "failed"
			throw new Error(
				`Workspace changed after review: ${verification.conflicts.map((conflict) => conflict.path).join(", ")}`,
			)
		}
		this.state = "applying"
		const journal = await this.prepareJournal(expectedPatchSha256)
		this.journal = journal
		const concurrentPaths = new Set<string>()
		try {
			for (const entry of journal.entries) {
				const base = this.base.get(entry.path)
				if (base?.exists) {
					const backupPath = this.siblingTempPath(entry.absolutePath, "base")
					await rename(entry.absolutePath, backupPath)
					entry.backupPath = backupPath
					if (!(await this.matchesSnapshot(backupPath, base))) {
						await link(backupPath, entry.absolutePath)
						await unlink(backupPath)
						entry.backupPath = undefined
						concurrentPaths.add(entry.path)
						throw new Error(`Workspace changed after base verification: ${entry.path}`)
					}
				}
				if (entry.stagedPath) {
					try {
						await link(entry.stagedPath, entry.absolutePath)
						entry.installed = true
						await unlink(entry.stagedPath)
					} catch (error) {
						if (!base?.exists && isAlreadyExists(error)) concurrentPaths.add(entry.path)
						throw error
					}
				}
			}
			this.state = "post_apply_checks"
			return {
				transactionId: this.id,
				patchSha256: expectedPatchSha256,
				appliedPaths: journal.entries.map((entry) => entry.path),
				rollbackAvailable: true,
			}
		} catch (error) {
			const rolledBack = await this.restoreJournal(journal, concurrentPaths)
			if (!rolledBack) {
				this.state = "hard_recovery"
				throw new Error(`Patch apply failed and rollback could not restore the workspace: ${String(error)}`)
			}
			this.state = "rolled_back"
			throw new Error(`Patch apply failed and was rolled back: ${String(error)}`)
		}
	}

	async finalizeApplied(): Promise<void> {
		if (this.state !== "post_apply_checks" || !this.journal) {
			throw new Error(`Cannot finalize transaction while ${this.state}`)
		}
		const verification = await this.verifyApplied(this.journal)
		if (!verification) {
			this.state = "hard_recovery"
			throw new Error("Applied workspace changed before finalization")
		}
		await this.cleanupJournal(this.journal)
		this.journal = undefined
		this.state = "applied"
	}

	async rollbackApplied(): Promise<void> {
		if (this.state !== "post_apply_checks" || !this.journal) {
			throw new Error(`Cannot roll back transaction while ${this.state}`)
		}
		if (!(await this.verifyApplied(this.journal)) || !(await this.restoreJournal(this.journal))) {
			this.state = "hard_recovery"
			throw new Error("Rollback could not safely restore the workspace")
		}
		this.journal = undefined
		this.state = "rolled_back"
	}

	async discard(): Promise<void> {
		if (!["exploring", "staging", "proposed", "revision", "accepted"].includes(this.state) || this.journal) {
			throw new Error(`Cannot discard transaction while ${this.state}`)
		}
		this.overlay.clear()
		this.renameOrigins.clear()
		this.acceptedPatchSha256 = undefined
		this.state = "discarded"
	}

	private assertMutable(): void {
		if (this.state !== "exploring" && this.state !== "staging" && this.state !== "revision") {
			throw new Error(`Transaction is sealed while ${this.state}`)
		}
	}

	private async normalizeAndGuard(
		inputPath: string,
		allowDirectory = false,
	): Promise<{ path: string; absolutePath: string }> {
		if (!inputPath.trim()) throw new Error("Path must not be empty")
		const absolutePath = resolve(isAbsolute(inputPath) ? inputPath : join(this.root, inputPath))
		const relativePath = relative(this.root, absolutePath)
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Path escapes transaction root: ${inputPath}`)
		}
		let cursor = this.root
		for (const segment of relativePath.split(sep)) {
			cursor = join(cursor, segment)
			try {
				const stat = await lstat(cursor)
				if (stat.isSymbolicLink()) {
					const target = await realpath(cursor).catch(() => cursor)
					throw new Error(`Symbolic links are not supported in transaction paths: ${relativePath} -> ${target}`)
				}
				if (cursor !== absolutePath && !stat.isDirectory()) {
					throw new Error(`Path parent is not a directory: ${relativePath}`)
				}
				if (cursor === absolutePath && stat.isDirectory() && !allowDirectory) {
					throw new Error(`Path is a directory: ${relativePath}`)
				}
			} catch (error) {
				if (isMissing(error)) break
				throw error
			}
		}
		return { path: relativePath.split(sep).join("/"), absolutePath }
	}

	private async captureBase(path: string, absolutePath: string): Promise<InternalBaseSnapshot> {
		const existing = this.base.get(path)
		if (existing) return existing
		try {
			const stat = await lstat(absolutePath)
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files can be staged: ${path}`)
			const bytes = await readFile(absolutePath)
			const content = bytes.toString("utf8")
			if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error(`Only UTF-8 text files can be staged: ${path}`)
			const snapshot: InternalBaseSnapshot = {
				path,
				absolutePath,
				exists: true,
				sha256: sha256(bytes),
				mode: normalizeMode(stat.mode),
				content,
			}
			this.base.set(path, snapshot)
			return snapshot
		} catch (error) {
			if (!isMissing(error)) throw error
			const snapshot: InternalBaseSnapshot = { path, absolutePath, exists: false }
			this.base.set(path, snapshot)
			return snapshot
		}
	}

	private async assertNoPathAlias(path: string, absolutePath: string): Promise<void> {
		const identity = await this.pathIdentity(absolutePath)
		for (const snapshot of this.base.values()) {
			if (snapshot.path === path) continue
			if ((await this.pathIdentity(snapshot.absolutePath)) === identity) {
				throw new Error(`Transaction path aliases ${snapshot.path}: ${path}`)
			}
		}
	}

	private async assertNoAliases(snapshots: InternalBaseSnapshot[]): Promise<void> {
		const pathsByIdentity = new Map<string, string>()
		for (const snapshot of snapshots) {
			const identity = await this.pathIdentity(snapshot.absolutePath, true)
			const existing = pathsByIdentity.get(identity)
			if (existing) throw new Error(`Transaction path aliases ${existing}: ${snapshot.path}`)
			pathsByIdentity.set(identity, snapshot.path)
		}
	}

	private async pathIdentity(absolutePath: string, probeCaseSensitivity = false): Promise<string> {
		try {
			const stat = await lstat(absolutePath)
			const canonicalPath = await realpath(absolutePath)
			return stat.ino === 0 ? `existing:${canonicalPath}` : `inode:${stat.dev}:${stat.ino}`
		} catch (error) {
			if (!isMissing(error)) throw error
		}

		let ancestor = dirname(absolutePath)
		for (;;) {
			try {
				const stat = await lstat(ancestor)
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${ancestor}`)
				break
			} catch (error) {
				if (!isMissing(error)) throw error
				const parent = dirname(ancestor)
				if (parent === ancestor) throw new Error(`No existing parent directory for: ${absolutePath}`)
				ancestor = parent
			}
		}
		const canonicalAncestor = await realpath(ancestor)
		const suffix = relative(ancestor, absolutePath).split(sep).join("/")
		const key =
			probeCaseSensitivity && (await this.isCaseInsensitiveDirectory(ancestor))
				? suffix.normalize("NFC").toLowerCase()
				: suffix
		return `missing:${canonicalAncestor}:${key}`
	}

	private async isCaseInsensitiveDirectory(directory: string): Promise<boolean> {
		const canonicalDirectory = await realpath(directory)
		let result = this.caseInsensitiveDirectories.get(canonicalDirectory)
		if (!result) {
			result = this.probeCaseInsensitiveDirectory(canonicalDirectory)
			this.caseInsensitiveDirectories.set(canonicalDirectory, result)
		}
		return result
	}

	private async probeCaseInsensitiveDirectory(directory: string): Promise<boolean> {
		const lowerPath = join(directory, `.kimchi-case-probe-${this.id}-${randomUUID()}a`)
		const upperPath = join(directory, basename(lowerPath).toUpperCase())
		await writeFile(lowerPath, "", { flag: "wx" })
		try {
			try {
				const [lower, upper] = await Promise.all([lstat(lowerPath), lstat(upperPath)])
				return lower.dev === upper.dev && lower.ino === upper.ino
			} catch (error) {
				if (isMissing(error)) return false
				throw error
			}
		} finally {
			await rm(lowerPath, { force: true })
		}
	}

	private operations(): ChangeOperation[] {
		const operations: ChangeOperation[] = []
		const consumed = new Set<string>()
		for (const [target, origin] of [...this.renameOrigins].sort(([left], [right]) => left.localeCompare(right))) {
			if (target === origin) continue
			const originBase = this.base.get(origin)
			const targetBase = this.base.get(target)
			const originEntry = this.overlay.get(origin)
			const targetEntry = this.overlay.get(target)
			if (
				originBase?.exists &&
				originBase.sha256 &&
				originEntry?.content === null &&
				targetBase &&
				!targetBase.exists &&
				targetEntry?.content !== null &&
				targetEntry?.content !== undefined
			) {
				operations.push({
					kind: "rename",
					fromPath: origin,
					path: target,
					baseSha256: originBase.sha256,
					content: targetEntry.content,
					mode: targetEntry.mode ?? originBase.mode,
				})
				consumed.add(origin)
				consumed.add(target)
			}
		}
		for (const [path, entry] of [...this.overlay].sort(([left], [right]) => left.localeCompare(right))) {
			if (consumed.has(path)) continue
			const snapshot = this.base.get(path)
			if (!snapshot) continue
			if (!snapshot.exists && entry.content !== null) {
				operations.push({ kind: "create", path, content: entry.content, mode: entry.mode ?? 0o644 })
			} else if (snapshot.exists && snapshot.sha256 && entry.content === null) {
				operations.push({ kind: "delete", path, baseSha256: snapshot.sha256 })
			} else if (
				snapshot.exists &&
				snapshot.sha256 &&
				entry.content !== null &&
				(entry.content !== snapshot.content || entry.mode !== snapshot.mode)
			) {
				operations.push({
					kind: "update",
					path,
					baseSha256: snapshot.sha256,
					content: entry.content,
					mode: entry.mode ?? snapshot.mode,
				})
			}
		}
		return operations.sort((left, right) => {
			const leftPath = left.kind === "rename" ? left.fromPath : left.path
			const rightPath = right.kind === "rename" ? right.fromPath : right.path
			return leftPath.localeCompare(rightPath) || left.path.localeCompare(right.path)
		})
	}

	private relevantBase(operations: ChangeOperation[]): BaseSnapshot[] {
		return this.internalRelevantBase(operations).map(
			({ absolutePath: _absolutePath, content: _content, ...snapshot }) => ({
				...snapshot,
			}),
		)
	}

	private internalRelevantBase(operations: ChangeOperation[]): InternalBaseSnapshot[] {
		const paths = new Set<string>()
		for (const operation of operations) {
			paths.add(operation.path)
			if (operation.kind === "rename") paths.add(operation.fromPath)
		}
		return [...paths]
			.sort()
			.map((path) => this.base.get(path))
			.filter((snapshot): snapshot is InternalBaseSnapshot => snapshot !== undefined)
	}

	private renderPatch(operations: ChangeOperation[]): string {
		const sections = ["# kimchi-change-set v1"]
		for (const operation of operations) {
			if (operation.kind === "create") {
				sections.push(
					`# create ${operation.path} mode=${(operation.mode ?? 0o644).toString(8)}`,
					generateUnifiedPatch(operation.path, "", operation.content),
				)
			} else if (operation.kind === "update") {
				sections.push(
					`# update ${operation.path} base=${operation.baseSha256} mode=${(operation.mode ?? 0o644).toString(8)}`,
					generateUnifiedPatch(operation.path, this.base.get(operation.path)?.content ?? "", operation.content),
				)
			} else if (operation.kind === "delete") {
				sections.push(
					`# delete ${operation.path} base=${operation.baseSha256}`,
					generateUnifiedPatch(operation.path, this.base.get(operation.path)?.content ?? "", ""),
				)
			} else {
				sections.push(
					`# rename ${operation.fromPath} -> ${operation.path} base=${operation.baseSha256} mode=${(operation.mode ?? 0o644).toString(8)}`,
					generateUnifiedPatch(operation.fromPath, this.base.get(operation.fromPath)?.content ?? "", ""),
					generateUnifiedPatch(operation.path, "", operation.content),
				)
			}
		}
		return `${sections.join("\n")}\n`
	}

	private async prepareJournal(patchSha256: string): Promise<ApplyJournal> {
		const desired = new Map<string, DesiredFile | undefined>()
		for (const operation of this.changeSet().operations) {
			if (operation.kind === "delete") desired.set(operation.path, undefined)
			else if (operation.kind === "rename") {
				desired.set(operation.fromPath, undefined)
				desired.set(operation.path, { content: operation.content, mode: operation.mode ?? 0o644 })
			} else {
				desired.set(operation.path, { content: operation.content, mode: operation.mode ?? 0o644 })
			}
		}
		const createdDirectories: string[] = []
		const entries: ApplyEntry[] = []
		try {
			for (const [path, next] of [...desired].sort(([left], [right]) => left.localeCompare(right))) {
				const absolutePath = resolve(this.root, path)
				await this.normalizeAndGuard(absolutePath)
				const entry: ApplyEntry = { path, absolutePath, desired: next }
				if (next) {
					await this.ensureParentDirectories(dirname(absolutePath), createdDirectories)
					entry.stagedPath = this.siblingTempPath(absolutePath, "next")
					await writeFile(entry.stagedPath, next.content, { encoding: "utf8", flag: "wx", mode: next.mode })
					await chmod(entry.stagedPath, next.mode)
				}
				entries.push(entry)
			}
			return { entries, createdDirectories, patchSha256 }
		} catch (error) {
			await this.cleanupJournal({ entries, createdDirectories, patchSha256 })
			this.state = "failed"
			throw error
		}
	}

	private async ensureParentDirectories(path: string, created: string[]): Promise<void> {
		const pending: string[] = []
		let cursor = path
		while (cursor !== this.root) {
			try {
				const stat = await lstat(cursor)
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${cursor}`)
				break
			} catch (error) {
				if (!isMissing(error)) throw error
				pending.push(cursor)
				cursor = dirname(cursor)
			}
		}
		if (cursor === dirname(cursor) && cursor !== this.root)
			throw new Error(`Directory escapes transaction root: ${path}`)
		for (const directory of pending.reverse()) {
			await mkdir(directory)
			created.push(directory)
		}
	}

	private siblingTempPath(path: string, kind: "next" | "base"): string {
		return join(dirname(path), `.${basename(path)}.kimchi-${this.id}.${kind}.${randomUUID()}`)
	}

	private async verifyApplied(journal: ApplyJournal): Promise<boolean> {
		for (const entry of journal.entries) {
			try {
				const stat = await lstat(entry.absolutePath)
				if (!entry.desired || !stat.isFile() || stat.isSymbolicLink()) return false
				if (sha256(await readFile(entry.absolutePath)) !== sha256(entry.desired.content)) return false
				if (normalizeMode(stat.mode) !== entry.desired.mode) return false
			} catch (error) {
				if (isMissing(error) && !entry.desired) continue
				return false
			}
		}
		return true
	}

	private async matchesSnapshot(path: string, snapshot: InternalBaseSnapshot): Promise<boolean> {
		try {
			const stat = await lstat(path)
			return (
				snapshot.exists &&
				stat.isFile() &&
				!stat.isSymbolicLink() &&
				sha256(await readFile(path)) === snapshot.sha256 &&
				normalizeMode(stat.mode) === snapshot.mode
			)
		} catch {
			return false
		}
	}

	private async restoreJournal(journal: ApplyJournal, concurrentPaths = new Set<string>()): Promise<boolean> {
		try {
			if (!(await this.verifyRestorable(journal, concurrentPaths))) return false
			for (const entry of [...journal.entries].reverse()) {
				if (concurrentPaths.has(entry.path)) {
					if (entry.stagedPath) await rm(entry.stagedPath, { force: true })
					continue
				}
				if (entry.installed) await rm(entry.absolutePath, { force: true })
				if (entry.backupPath) await rename(entry.backupPath, entry.absolutePath)
				if (entry.stagedPath) await rm(entry.stagedPath, { force: true })
			}
			for (const directory of [...journal.createdDirectories].reverse()) {
				await rmdir(directory).catch((error) => {
					if (!isMissing(error) && (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTEMPTY")) {
						throw error
					}
				})
			}
			const verification = await this.verifyBase()
			return verification.conflicts.every(({ path }) => concurrentPaths.has(path))
		} catch {
			return false
		}
	}

	private async verifyRestorable(journal: ApplyJournal, concurrentPaths = new Set<string>()): Promise<boolean> {
		for (const entry of journal.entries) {
			if (concurrentPaths.has(entry.path)) continue
			const base = this.base.get(entry.path)
			if (!base) return false
			if (entry.backupPath) {
				try {
					const backupStat = await lstat(entry.backupPath)
					if (!base.exists || !backupStat.isFile() || backupStat.isSymbolicLink()) return false
					if (sha256(await readFile(entry.backupPath)) !== base.sha256) return false
					if (normalizeMode(backupStat.mode) !== base.mode) return false
				} catch {
					return false
				}
			}
			if (entry.installed) {
				try {
					const currentStat = await lstat(entry.absolutePath)
					if (!entry.desired || !currentStat.isFile() || currentStat.isSymbolicLink()) return false
					if (sha256(await readFile(entry.absolutePath)) !== sha256(entry.desired.content)) return false
					if (normalizeMode(currentStat.mode) !== entry.desired.mode) return false
				} catch {
					return false
				}
				continue
			}
			if (entry.backupPath) {
				try {
					await lstat(entry.absolutePath)
					return false
				} catch (error) {
					if (!isMissing(error)) return false
				}
				continue
			}
			try {
				const currentStat = await lstat(entry.absolutePath)
				if (!base.exists || !currentStat.isFile() || currentStat.isSymbolicLink()) return false
				if (sha256(await readFile(entry.absolutePath)) !== base.sha256) return false
				if (normalizeMode(currentStat.mode) !== base.mode) return false
			} catch (error) {
				if (!isMissing(error) || base.exists) return false
			}
		}
		return true
	}

	private async cleanupJournal(journal: ApplyJournal): Promise<void> {
		for (const entry of journal.entries) {
			if (entry.stagedPath) await rm(entry.stagedPath, { force: true })
			if (entry.backupPath) await rm(entry.backupPath, { force: true })
		}
		for (const directory of [...journal.createdDirectories].reverse()) {
			await rmdir(directory).catch(() => undefined)
		}
	}
}
