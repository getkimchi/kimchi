import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Database } from "better-sqlite3"
import { historyDbPath } from "./backend.js"
import type { CaptureBackend } from "./commit.js"
import { normalizeFactText } from "./commit.js"
import { MEMORY_USER_ID } from "./config.js"
import { isNearDuplicate } from "./diversity.js"
import { acquireCaptureLock } from "./lock.js"
import { auditCaptureQueue, type CaptureQueueAudit } from "./maintenance-queue.js"
import { readMemoryMetadata } from "./metadata.js"

type MaintenanceBackend = Pick<CaptureBackend, "getAll" | "delete"> & {
	update?: (id: string, options: { metadata?: Record<string, unknown> }) => Promise<unknown>
}

type MaintenanceSnapshotBackend = Pick<CaptureBackend, "getAll">

export interface SnapshotRow {
	id: string
	vector: number[]
	payload: Record<string, unknown>
}

export type SnapshotValue = string | number | number[] | null

export interface SnapshotTable {
	name: string
	schema: string
	rows: Array<Record<string, SnapshotValue>>
}

export interface SnapshotStore {
	readRows: (dbPath: string) => SnapshotRow[]
	restoreRows: (dbPath: string, rows: SnapshotRow[]) => void
	readTables?: (dbPath: string) => SnapshotTable[]
	restoreTables?: (dbPath: string, tables: SnapshotTable[]) => void
}

export interface MemoryMaintenanceOptions {
	dbPath: string
	backend: MaintenanceBackend
	memoryRoot?: string
	acquireLock?: (root: string) => Promise<(() => Promise<void>) | null>
	snapshotStore?: SnapshotStore
}

export interface MemoryAudit {
	raw: number
	exactUnique: number
	normalizedUnique: number
	normalizedDuplicates: number
	duplicateGroups: number
	nearClusters: number
	metadataCount: number
	normalizedHashCount: number
	normalizedCanonicalIds: string[]
	groups: Array<{ canonicalId: string; ids: string[]; normalizedText: string }>
}

export interface MaintenanceManifest {
	version: 1
	status: "snapshot" | "deduped"
	snapshotId: string
	source: string
	/** Present in newly-created manifests; legacy checkpoints use rollback's configured root. */
	lockRoot?: string
	/** Legacy file entries without kind are vectors. */
	files: Array<{ source: string; snapshot: string; sha256: string; kind?: "vectors" | "history" }>
	metadataCount: number
	expectedIds: string[]
	canonicalSupport: Array<{ canonicalId: string; duplicateIds: string[] }>
	expectedHashes?: Record<string, string>
}

interface Fact {
	id: string
	memory: string
	metadata?: unknown
}

async function allFacts(backend: MaintenanceSnapshotBackend): Promise<Fact[]> {
	const { results } = await backend.getAll({ filters: { user_id: MEMORY_USER_ID } })
	return results
}

export async function auditMemory(
	backend: MaintenanceSnapshotBackend,
	existing?: readonly Fact[],
): Promise<MemoryAudit> {
	const facts = existing ?? (await allFacts(backend))
	const groups = new Map<string, Fact[]>()
	for (const fact of facts) {
		const key = normalizeFactText(fact.memory)
		const group = groups.get(key) ?? []
		group.push(fact)
		groups.set(key, group)
	}
	const repeated = [...groups.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([text, group]) => ({
			canonicalId: group[0]?.id ?? "",
			ids: group.map((fact) => fact.id),
			normalizedText: text,
		}))
	return {
		raw: facts.length,
		exactUnique: new Set(facts.map((fact) => fact.id)).size,
		normalizedUnique: groups.size,
		normalizedDuplicates: facts.length - groups.size,
		duplicateGroups: repeated.length,
		nearClusters: facts.filter((fact, i) =>
			facts.slice(i + 1).some((other) => isNearDuplicate(fact.memory, other.memory)),
		).length,
		metadataCount: facts.filter((fact) => fact.metadata !== undefined).length,
		normalizedHashCount: facts.filter(
			(fact) => typeof (fact.metadata as { normalizedTextHash?: unknown } | undefined)?.normalizedTextHash === "string",
		).length,
		normalizedCanonicalIds: [...groups.values()].map((group) => group[0]?.id ?? ""),
		groups: repeated,
	}
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex")
}

function fileHash(path: string): string {
	return sha256(readFileSync(path))
}

function atomicWrite(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const temp = `${path}.${process.pid}.tmp`
	writeFileSync(temp, body, { mode: 0o600 })
	renameSync(temp, path)
}

async function snapshotOf(
	options: MemoryMaintenanceOptions,
): Promise<{ path: string; manifest: MaintenanceManifest; queue: CaptureQueueAudit }> {
	const facts = await allFacts(options.backend)
	const audit = await auditMemory(options.backend, facts)
	const byId = new Map(facts.map((fact) => [fact.id, fact]))
	const duplicateIds = new Set(audit.groups.flatMap((group) => group.ids))
	const canonicalSupport = audit.groups.map((group) => {
		const canonicalId = chooseCanonical(group, byId, [])
		if (!canonicalId) throw new Error("duplicate group has no canonical fact")
		return { canonicalId, duplicateIds: group.ids.filter((id) => id !== canonicalId) }
	})
	const expectedIds = [
		...canonicalSupport.map((group) => group.canonicalId),
		...facts.flatMap((fact) => (duplicateIds.has(fact.id) ? [] : [fact.id])),
	]
	const rows = [...(options.snapshotStore?.readRows(options.dbPath) ?? readRows(options.dbPath))].sort((a, b) =>
		a.id.localeCompare(b.id),
	)
	const historyPath = historyDbPath(options.dbPath)
	const history = existsSync(historyPath)
		? (options.snapshotStore?.readTables?.(historyPath) ?? readTables(historyPath))
		: []
	const snapshotId = `dedupe-${sha256(JSON.stringify({ vectors: rows, history })).slice(0, 16)}`
	const directory = join(dirname(options.dbPath), "maintenance", snapshotId)
	mkdirSync(directory, { recursive: true })
	const manifest: MaintenanceManifest = {
		version: 1,
		status: "snapshot",
		snapshotId,
		source: options.dbPath,
		lockRoot: options.memoryRoot ?? dirname(options.dbPath),
		files: [
			{
				source: options.dbPath,
				snapshot: join(directory, "snapshot.json"),
				sha256: sha256(JSON.stringify(rows)),
				kind: "vectors",
			},
			...(existsSync(historyPath)
				? [
						{
							source: historyPath,
							snapshot: join(directory, "history.json"),
							sha256: sha256(JSON.stringify(history)),
							kind: "history" as const,
						},
					]
				: []),
		],
		metadataCount: audit.metadataCount,
		expectedIds,
		canonicalSupport,
	}
	for (const file of manifest.files) {
		if (!existsSync(file.snapshot)) atomicWrite(file.snapshot, JSON.stringify(file.kind === "history" ? history : rows))
		if (fileHash(file.snapshot) !== file.sha256) throw new Error(`snapshot checksum mismatch: ${file.snapshot}`)
	}
	return { path: directory, manifest, queue: auditCaptureQueue(options.memoryRoot ?? dirname(options.dbPath)) }
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

function snapshotValue(value: unknown): SnapshotValue {
	if (value === null || typeof value === "string") return value
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (value instanceof Uint8Array) return Array.from(value)
	if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return value
	throw new Error(`unsupported SQLite value in snapshot: ${typeof value}`)
}

function restoredValue(value: SnapshotValue): string | number | Uint8Array | null {
	return Array.isArray(value) ? Buffer.from(value) : value
}

function readTables(dbPath: string): SnapshotTable[] {
	const db = new Database(dbPath)
	try {
		const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{
			name: unknown
			sql: unknown
		}>
		return tables.flatMap(({ name, sql }) => {
			if (typeof name !== "string" || typeof sql !== "string" || name.startsWith("sqlite_")) return []
			const rows = (db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all() as Array<Record<string, unknown>>).map(
				(row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, snapshotValue(value)])),
			)
			return [{ name, schema: sql, rows }]
		})
	} finally {
		db.close()
	}
}

function restoreTables(dbPath: string, input: unknown): void {
	if (!Array.isArray(input)) throw new Error("history snapshot must be an array")
	const tables = input.map(validateSnapshotTable)
	const db = new Database(dbPath)
	try {
		db.transaction(() => {
			for (const table of tables) {
				db.exec(
					/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(table.schema)
						? table.schema
						: table.schema.replace(/^\s*CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS "),
				)
				db.prepare(`DELETE FROM ${quoteIdentifier(table.name)}`).run()
				const columns = table.rows[0] ? Object.keys(table.rows[0]) : []
				if (columns.length === 0) continue
				const insert = db.prepare(
					"INSERT INTO " +
						quoteIdentifier(table.name) +
						" (" +
						columns.map(quoteIdentifier).join(", ") +
						") VALUES (" +
						columns.map(() => "?").join(", ") +
						")",
				)
				for (const row of table.rows) insert.run(...columns.map((column) => restoredValue(row[column])))
			}
		})()
	} finally {
		db.close()
	}
}

function validateSnapshotTable(input: unknown): SnapshotTable {
	if (!input || typeof input !== "object") throw new Error("invalid snapshot table")
	const table = input as { name?: unknown; schema?: unknown; rows?: unknown }
	if (typeof table.name !== "string" || typeof table.schema !== "string" || !Array.isArray(table.rows)) {
		throw new Error("invalid snapshot table metadata")
	}
	const statements = table.schema.split(";").filter((statement) => statement.trim())
	if (statements.length !== 1 || !statements[0]?.trim().toUpperCase().startsWith("CREATE TABLE ")) {
		throw new Error("unsupported history schema")
	}
	const rows = table.rows.map((row) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid snapshot row")
		return Object.fromEntries(
			Object.entries(row).map(([column, value]) => {
				if (Array.isArray(value) && !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
					throw new Error("invalid snapshot BLOB")
				}
				return [column, snapshotValue(value)]
			}),
		)
	})
	return { name: table.name, schema: table.schema, rows }
}

function readRows(dbPath: string): SnapshotRow[] {
	const db = new Database(dbPath)
	try {
		db.exec(`CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)`)
		return (
			db
				.prepare("SELECT id, vector, payload FROM vectors WHERE json_extract(payload, '$.user_id') = ?")
				.all(MEMORY_USER_ID) as Array<{
				id: string
				vector: Uint8Array
				payload: string
			}>
		).map((row) => ({
			id: row.id,
			vector: Array.from(row.vector),
			payload: JSON.parse(row.payload) as Record<string, unknown>,
		}))
	} finally {
		db.close()
	}
}

function restoreRows(dbPath: string, rows: SnapshotRow[]): void {
	const db = new Database(dbPath)
	try {
		db.transaction(() => {
			const existing = db
				.prepare("SELECT id FROM vectors WHERE json_extract(payload, '$.user_id') = ?")
				.all(MEMORY_USER_ID) as Array<{ id: string }>
			for (const row of existing) db.prepare("DELETE FROM vectors WHERE id = ?").run(row.id)
			for (const row of rows)
				db.prepare("INSERT OR REPLACE INTO vectors (id, vector, payload) VALUES (?, ?, ?)").run(
					row.id,
					Buffer.from(row.vector),
					JSON.stringify(row.payload),
				)
		})()
	} finally {
		db.close()
	}
}

type RestoreArtifact =
	| { kind: "history"; source: string; data: SnapshotTable[] }
	| { kind: "vectors" | undefined; source: string; data: SnapshotRow[] }

function validateVectorSnapshot(input: unknown): SnapshotRow[] {
	if (!Array.isArray(input)) throw new Error("vector snapshot must be an array")
	return input.map((row) => {
		if (!row || typeof row !== "object") throw new Error("invalid vector snapshot row")
		const value = row as { id?: unknown; vector?: unknown; payload?: unknown }
		if (typeof value.id !== "string" || !value.payload || typeof value.payload !== "object") {
			throw new Error("invalid vector snapshot metadata")
		}
		if (
			!Array.isArray(value.vector) ||
			!value.vector.every((byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)
		) {
			throw new Error("invalid vector snapshot BLOB")
		}
		if (Array.isArray(value.payload)) throw new Error("invalid vector snapshot payload")
		return { id: value.id, vector: value.vector as number[], payload: value.payload as Record<string, unknown> }
	})
}

function readRollbackArtifact(file: MaintenanceManifest["files"][number], sourceDb: string): RestoreArtifact {
	if (fileHash(file.snapshot) !== file.sha256) throw new Error(`snapshot checksum mismatch: ${file.snapshot}`)
	if (file.kind === "history") {
		if (resolve(file.source) !== resolve(historyDbPath(sourceDb)))
			throw new Error("history belongs to a different memory store")
		const data: unknown = JSON.parse(readFileSync(file.snapshot, "utf-8"))
		if (!Array.isArray(data)) throw new Error("history snapshot must be an array")
		return { kind: "history", source: file.source, data: data.map(validateSnapshotTable) }
	}
	if (file.kind !== undefined && file.kind !== "vectors") throw new Error("unsupported artifact kind")
	if (resolve(file.source) !== resolve(sourceDb)) throw new Error("snapshot belongs to a different memory store")
	return {
		kind: file.kind,
		source: file.source,
		data: validateVectorSnapshot(JSON.parse(readFileSync(file.snapshot, "utf-8"))),
	}
}

function matchesFacts(
	current: readonly Fact[],
	ids: readonly string[],
	hashes: Record<string, string> | undefined,
): boolean {
	if (!hashes) return false
	const expected = new Set(ids)
	const actual = new Set(current.map((fact) => fact.id))
	if (expected.size !== actual.size) return false
	return current.every((fact) => hashes[fact.id] === sha256(JSON.stringify(fact)))
}

function chooseCanonical(
	group: MemoryAudit["groups"][number],
	before: ReadonlyMap<string, Fact>,
	previousSupport: MaintenanceManifest["canonicalSupport"],
): string | undefined {
	const support = new Map(previousSupport.map((entry) => [entry.canonicalId, entry]))
	for (const id of group.ids) {
		const saved = support.get(id)
		if (!saved) continue
		const members = [saved.canonicalId, ...saved.duplicateIds]
		if (members.length === group.ids.length && members.every((member) => group.ids.includes(member)))
			return saved.canonicalId
	}
	const enriched = group.ids.filter((id) => {
		const fact = before.get(id)
		if (!fact) return false
		const metadata = readMemoryMetadata(fact.metadata, fact.memory)
		return metadata.canonical === true || metadata.kind !== "unclassified"
	})
	return enriched.sort((a, b) => a.localeCompare(b))[0] ?? [...group.ids].sort((a, b) => a.localeCompare(b))[0]
}

export async function dedupeMemory(
	options: MemoryMaintenanceOptions,
): Promise<{ audit: MemoryAudit; checkpoint: string; queue: CaptureQueueAudit }> {
	const release = await (options.acquireLock ?? acquireCaptureLock)(options.memoryRoot ?? dirname(options.dbPath))
	if (!release) throw new Error("capture worker is active; defer maintenance")
	try {
		const { path, manifest, queue } = await snapshotOf(options)
		const manifestPath = join(path, "manifest.json")
		if (
			existsSync(manifestPath) &&
			JSON.parse(readFileSync(manifestPath, "utf-8")).status === "deduped" &&
			(await auditMemory(options.backend)).normalizedDuplicates === 0
		) {
			return { audit: await auditMemory(options.backend), checkpoint: manifestPath, queue }
		}
		// The incomplete checkpoint must exist before the first mutation, not
		// only after every canonical update and deletion has succeeded.
		atomicWrite(manifestPath, JSON.stringify(manifest))
		const before = await allFacts(options.backend)
		const byId = new Map(before.map((fact) => [fact.id, fact]))
		for (const group of (await auditMemory(options.backend)).groups) {
			const canonical = chooseCanonical(group, byId, manifest.canonicalSupport)
			const duplicates = group.ids.filter((id) => id !== canonical)
			if (!canonical) continue
			if (!options.backend.update) throw new Error("exact dedupe requires canonical provenance updates")
			const original = byId.get(canonical)
			const metadata = readMemoryMetadata(original?.metadata, original?.memory ?? group.normalizedText)
			const canonicalFlag = metadata.kind !== "hypothesis"
			const supportIds = [...new Set([...(metadata.supportIds ?? []).filter((id) => id !== canonical), ...duplicates])]
			const alreadyApplied =
				(metadata.canonical ?? false) === canonicalFlag && supportIds.every((id) => metadata.supportIds?.includes(id))
			if (!alreadyApplied) {
				await options.backend.update(canonical, { metadata: { ...metadata, canonical: canonicalFlag, supportIds } })
			}
			for (const id of duplicates) await options.backend.delete(id)
		}
		const expectedHashes = Object.fromEntries(
			(await allFacts(options.backend)).map((fact) => [fact.id, sha256(JSON.stringify(fact))]),
		)
		atomicWrite(manifestPath, JSON.stringify({ ...manifest, status: "deduped", expectedHashes }))
		return { audit: await auditMemory(options.backend), checkpoint: manifestPath, queue }
	} finally {
		await release()
	}
}

export async function rollbackMaintenance(
	manifestPath: string,
	backend: MaintenanceSnapshotBackend,
	options: Partial<Pick<MemoryMaintenanceOptions, "dbPath" | "snapshotStore" | "memoryRoot" | "acquireLock">> = {},
): Promise<void> {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as MaintenanceManifest
	if (!manifest.expectedHashes) throw new Error("dedupe has not completed; refusing rollback")
	if (options.dbPath && resolve(options.dbPath) !== resolve(manifest.source)) {
		throw new Error("checkpoint belongs to a different memory store")
	}
	const release = await (options.acquireLock ?? acquireCaptureLock)(
		manifest.lockRoot ?? options.memoryRoot ?? dirname(manifest.source),
	)
	if (!release) throw new Error("capture worker is active; defer rollback")
	try {
		const current = await allFacts(backend)
		const restore = options.snapshotStore?.restoreRows ?? restoreRows
		const restoreHistory = options.snapshotStore?.restoreTables ?? restoreTables
		const artifacts = manifest.files.map((file) => readRollbackArtifact(file, manifest.source))
		const vector = artifacts.find((artifact) => artifact.kind !== "history")
		if (!vector) throw new Error("snapshot has no vector export")
		const snapshotIds = vector.data.map((row) => row.id)
		const snapshotHashes = Object.fromEntries(
			vector.data.map((row) => {
				if (typeof row.payload.data !== "string") throw new Error("snapshot has invalid text")
				const metadata =
					row.payload.metadata === undefined ? undefined : readMemoryMetadata(row.payload.metadata, row.payload.data)
				return [row.id, sha256(JSON.stringify({ id: row.id, memory: row.payload.data, metadata }))]
			}),
		)
		if (
			!matchesFacts(current, manifest.expectedIds, manifest.expectedHashes) &&
			!matchesFacts(current, snapshotIds, snapshotHashes)
		) {
			throw new Error("store changed unexpectedly after dedupe; rollback refused")
		}
		for (const artifact of artifacts) {
			if (artifact.kind === "history") restoreHistory(artifact.source, artifact.data)
			else restore(artifact.source, artifact.data)
		}
	} finally {
		await release()
	}
}

export async function maintainMemory(
	options: MemoryMaintenanceOptions,
): Promise<{ checkpoint: string; audit: MemoryAudit; queue: CaptureQueueAudit }> {
	const release = await (options.acquireLock ?? acquireCaptureLock)(options.memoryRoot ?? dirname(options.dbPath))
	if (!release) throw new Error("capture worker is active; defer maintenance")
	try {
		const { path, manifest, queue } = await snapshotOf(options)
		const manifestPath = join(path, "manifest.json")
		atomicWrite(manifestPath, JSON.stringify(manifest))
		return { checkpoint: manifestPath, audit: await auditMemory(options.backend), queue }
	} finally {
		await release()
	}
}

/** Root for the management surface: the explicit checkpoint needed before
 * correcting, inspecting, or rolling back a maintenance action. */
export type MaintenanceCheckpoint = ReturnType<typeof maintainMemory>
