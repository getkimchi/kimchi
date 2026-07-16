/**
 * Index build/update/search for the code-rag extension.
 *
 * The index is a single JSON file at .kimchi/code-rag/index.json (the .kimchi
 * directory is already gitignored). Vectors are stored as base64-encoded
 * Float32Array buffers — ~4KB per chunk at 1024 dims — so a repo of a few
 * thousand chunks stays in the tens of MB.
 *
 * Freshness model (no fs watcher in the PoC): every update pass stats the
 * git-visible file list and re-embeds only files whose mtime+size (then
 * content hash) changed. /index runs an unbounded pass; code_search runs the
 * same pass capped at MAX_STALE_FILES_PER_SEARCH so a search never blocks for
 * more than a few seconds behind a large rebase.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { type CodeChunk, chunkFile, embeddingInputForChunk } from "./chunker.js"
import { CodeRagError, embedTexts, formatQueryForEmbedding, INDEX_DIMS, resolveEmbedModel } from "./embedder.js"

const INDEX_RELATIVE_PATH = join(".kimchi", "code-rag", "index.json")
const MAX_FILE_BYTES = 256 * 1024
const EMBED_BATCH_SIZE = 32
/** Batches in flight at once. Keeps the pipe full when the server overlaps
 *  requests, without inflating per-request latency too far on servers that
 *  serialize them (oMLX's eager embedding path processes one at a time). */
const EMBED_CONCURRENCY = 2
/** Persist the index after this many freshly-embedded chunks so a crashed or
 *  interrupted build resumes from the last checkpoint instead of zero. */
const CHECKPOINT_CHUNKS = 512
const RETRY_DELAY_MS = 2000
/** Search-time freshness cap: re-embed at most this many changed files before
 *  answering. Beyond it the search runs on the stale index and reports how
 *  many files are pending so the model can suggest /index. */
export const MAX_STALE_FILES_PER_SEARCH = 24

const INDEXABLE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"rb",
	"php",
	"c",
	"h",
	"cpp",
	"hpp",
	"cc",
	"cs",
	"swift",
	"scala",
	"lua",
	"zig",
	"md",
	"mdx",
	"yaml",
	"yml",
	"toml",
	"json",
	"sh",
	"zsh",
	"bash",
	"sql",
	"css",
	"scss",
	"html",
	"vue",
	"svelte",
	"graphql",
	"proto",
	"tf",
])
const EXCLUDED_BASENAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"])

interface StoredFile {
	hash: string
	mtimeMs: number
	size: number
}

interface StoredChunk extends CodeChunk {
	/** base64-encoded Float32Array, L2-normalized, INDEX_DIMS long */
	vector: string
}

export interface CodeRagIndex {
	version: 1
	model: string
	dims: number
	updatedAt: string
	files: Record<string, StoredFile>
	chunks: StoredChunk[]
}

export interface IndexProgress {
	embeddedChunks: number
	totalChunks: number
}

export interface UpdateOptions {
	signal?: AbortSignal
	onProgress?: (progress: IndexProgress) => void
	/** Skip the update (leaving files stale) once this many changed files have
	 *  been re-embedded. Unbounded when omitted. */
	maxChangedFiles?: number
	/** Fail instead of building from scratch when no index exists yet. Used by
	 *  code_search so the first index build is always an explicit /index. */
	requireExisting?: boolean
}

export interface UpdateStats {
	files: number
	chunks: number
	embeddedChunks: number
	changedFiles: number
	removedFiles: number
	/** Files known to be stale but skipped because of maxChangedFiles. */
	pendingStaleFiles: number
}

export interface SearchResult {
	file: string
	startLine: number
	endLine: number
	score: number
	text: string
}

export function indexFilePath(cwd: string): string {
	return join(cwd, INDEX_RELATIVE_PATH)
}

export function loadIndex(cwd: string): CodeRagIndex | null {
	try {
		const parsed = JSON.parse(readFileSync(indexFilePath(cwd), "utf-8")) as CodeRagIndex
		if (parsed?.version !== 1 || !Array.isArray(parsed.chunks) || typeof parsed.files !== "object") return null
		return parsed
	} catch {
		return null
	}
}

function saveIndex(cwd: string, index: CodeRagIndex): void {
	const path = indexFilePath(cwd)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(index), "utf-8")
}

function fileEligible(relPath: string): boolean {
	// Never index kimchi's own project state (including this extension's index,
	// which would otherwise re-embed itself on every save in repos that don't
	// gitignore .kimchi/).
	if (relPath === ".kimchi" || relPath.startsWith(".kimchi/")) return false
	const base = relPath.slice(relPath.lastIndexOf("/") + 1)
	if (EXCLUDED_BASENAMES.has(base)) return false
	if (base.includes(".min.")) return false
	const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase()
	return INDEXABLE_EXTENSIONS.has(ext)
}

/** Tracked + untracked-but-not-ignored files, filtered to indexable ones.
 *  Requires a git repo — the PoC leans on git for ignore semantics. */
export function listIndexableFiles(cwd: string): string[] {
	let output: string
	try {
		output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		})
	} catch {
		throw new CodeRagError("code_search requires a git repository (file discovery uses git ls-files)")
	}
	return output.split("\0").filter((p) => p.length > 0 && fileEligible(p))
}

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
	try {
		const stats = statSync(path)
		if (!stats.isFile()) return null
		return { mtimeMs: stats.mtimeMs, size: stats.size }
	} catch {
		return null
	}
}

function looksBinary(content: string): boolean {
	return content.includes("\0")
}

function encodeVector(vector: Float32Array): string {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64")
}

function decodeVector(encoded: string): Float32Array {
	const buffer = Buffer.from(encoded, "base64")
	return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

/** One retry after a short delay covers transient server hiccups (model
 *  reload, momentary overload) without masking persistent failures. */
async function embedBatchWithRetry(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	try {
		return await embedTexts(texts, { signal })
	} catch (error) {
		if (signal?.aborted || !(error instanceof CodeRagError)) throw error
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
		return embedTexts(texts, { signal })
	}
}

function emptyIndex(): CodeRagIndex {
	return {
		version: 1,
		model: resolveEmbedModel(),
		dims: INDEX_DIMS,
		updatedAt: new Date().toISOString(),
		files: {},
		chunks: [],
	}
}

/**
 * Incrementally bring the index in line with the working tree.
 *
 * Change detection is two-stage: mtime+size first (no I/O beyond stat), then
 * a content hash so touched-but-identical files (branch switches, formatters
 * that no-op) skip re-embedding.
 */
export async function updateIndex(cwd: string, options: UpdateOptions = {}): Promise<UpdateStats> {
	const existing = loadIndex(cwd)
	if (!existing && options.requireExisting) {
		throw new CodeRagError("No code index found for this project. Ask the user to run /index to build it.")
	}
	const model = resolveEmbedModel()
	// A model or dims change invalidates every stored vector.
	const base = existing && existing.model === model && existing.dims === INDEX_DIMS ? existing : emptyIndex()

	const currentFiles = listIndexableFiles(cwd)
	const currentSet = new Set(currentFiles)

	const nextFiles: Record<string, StoredFile> = {}
	const keptChunks: StoredChunk[] = []
	const chunksByFile = new Map<string, StoredChunk[]>()
	for (const chunk of base.chunks) {
		let list = chunksByFile.get(chunk.file)
		if (!list) {
			list = []
			chunksByFile.set(chunk.file, list)
		}
		list.push(chunk)
	}

	interface PendingFile {
		file: string
		stored: StoredFile
		chunks: CodeChunk[]
	}
	const pending: PendingFile[] = []
	let pendingStaleFiles = 0

	for (const file of currentFiles) {
		options.signal?.throwIfAborted()
		const stats = statOrNull(join(cwd, file))
		if (!stats || stats.size > MAX_FILE_BYTES) continue

		const known = base.files[file]
		if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
			nextFiles[file] = known
			keptChunks.push(...(chunksByFile.get(file) ?? []))
			continue
		}

		let content: string
		try {
			content = readFileSync(join(cwd, file), "utf-8")
		} catch {
			continue
		}
		if (looksBinary(content)) continue

		const hash = createHash("sha1").update(content).digest("hex")
		if (known && known.hash === hash) {
			nextFiles[file] = { hash, mtimeMs: stats.mtimeMs, size: stats.size }
			keptChunks.push(...(chunksByFile.get(file) ?? []))
			continue
		}

		if (options.maxChangedFiles !== undefined && pending.length >= options.maxChangedFiles) {
			// Over budget: keep whatever the index already has for this file.
			pendingStaleFiles++
			if (known) {
				nextFiles[file] = known
				keptChunks.push(...(chunksByFile.get(file) ?? []))
			}
			continue
		}

		pending.push({
			file,
			stored: { hash, mtimeMs: stats.mtimeMs, size: stats.size },
			chunks: chunkFile(file, content),
		})
	}

	const removedFiles = Object.keys(base.files).filter((f) => !currentSet.has(f)).length

	const toEmbed: CodeChunk[] = pending.flatMap((p) => p.chunks)
	const buildSnapshot = (): CodeRagIndex => ({
		version: 1,
		model,
		dims: INDEX_DIMS,
		updatedAt: new Date().toISOString(),
		files: nextFiles,
		chunks: keptChunks,
	})

	// Embed in concurrent waves of batches, folding finished files into
	// keptChunks/nextFiles as we go so periodic checkpoints capture only
	// fully-embedded files. A crash or abort mid-build then resumes from the
	// last checkpoint instead of zero.
	const vectors: Float32Array[] = []
	let completedFileIdx = 0
	let chunksConsumed = 0
	let chunksSinceCheckpoint = 0
	const waveSize = EMBED_BATCH_SIZE * EMBED_CONCURRENCY
	for (let i = 0; i < toEmbed.length; i += waveSize) {
		options.signal?.throwIfAborted()
		const wave = toEmbed.slice(i, i + waveSize)
		const batches: CodeChunk[][] = []
		for (let b = 0; b < wave.length; b += EMBED_BATCH_SIZE) {
			batches.push(wave.slice(b, b + EMBED_BATCH_SIZE))
		}
		const results = await Promise.all(
			batches.map((batch) => embedBatchWithRetry(batch.map(embeddingInputForChunk), options.signal)),
		)
		for (const result of results) vectors.push(...result)
		options.onProgress?.({
			embeddedChunks: Math.min(i + waveSize, toEmbed.length),
			totalChunks: toEmbed.length,
		})
		chunksSinceCheckpoint += wave.length

		while (
			completedFileIdx < pending.length &&
			chunksConsumed + pending[completedFileIdx].chunks.length <= vectors.length
		) {
			const p = pending[completedFileIdx]
			nextFiles[p.file] = p.stored
			for (const [j, chunk] of p.chunks.entries()) {
				keptChunks.push({ ...chunk, vector: encodeVector(vectors[chunksConsumed + j]) })
			}
			chunksConsumed += p.chunks.length
			completedFileIdx++
		}

		if (chunksSinceCheckpoint >= CHECKPOINT_CHUNKS && completedFileIdx < pending.length) {
			saveIndex(cwd, buildSnapshot())
			cachedRuntime = null
			chunksSinceCheckpoint = 0
		}
	}

	const next = buildSnapshot()
	// Skip the (multi-MB) rewrite when nothing changed at all.
	if (pending.length > 0 || removedFiles > 0 || !existing || base !== existing) {
		saveIndex(cwd, next)
		cachedRuntime = null
	}

	return {
		files: Object.keys(nextFiles).length,
		chunks: keptChunks.length,
		embeddedChunks: toEmbed.length,
		changedFiles: pending.length,
		removedFiles,
		pendingStaleFiles,
	}
}

interface RuntimeChunk extends CodeChunk {
	vector: Float32Array
}

/** Decoded-vector cache keyed by index mtime so consecutive searches skip the
 *  JSON parse + base64 decode of a multi-MB file. */
let cachedRuntime: { key: string; chunks: RuntimeChunk[] } | null = null

function loadRuntimeChunks(cwd: string): RuntimeChunk[] {
	const index = loadIndex(cwd)
	if (!index) {
		throw new CodeRagError("No code index found for this project. Ask the user to run /index to build it.")
	}
	const stats = statOrNull(indexFilePath(cwd))
	const key = `${cwd}:${stats?.mtimeMs ?? 0}:${stats?.size ?? 0}`
	if (cachedRuntime?.key === key) return cachedRuntime.chunks
	const chunks = index.chunks.map((c) => ({
		file: c.file,
		startLine: c.startLine,
		endLine: c.endLine,
		text: c.text,
		vector: decodeVector(c.vector),
	}))
	cachedRuntime = { key, chunks }
	return chunks
}

function dot(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length)
	let sum = 0
	for (let i = 0; i < n; i++) sum += a[i] * b[i]
	return sum
}

/** Cheap lexical leg of the hybrid score: exact query tokens appearing in the
 *  chunk (or its path) nudge the ranking. Catches identifier lookups that
 *  pure embeddings famously miss. */
function lexicalBonus(queryTokens: string[], chunk: RuntimeChunk): number {
	if (queryTokens.length === 0) return 0
	const haystack = `${chunk.file}\n${chunk.text}`.toLowerCase()
	let bonus = 0
	for (const token of queryTokens) {
		if (haystack.includes(token)) bonus += 0.03
	}
	return Math.min(bonus, 0.12)
}

const MAX_CHUNKS_PER_FILE = 2

export interface SearchOutcome {
	results: SearchResult[]
	/** Files whose changes were not re-embedded before this search. */
	pendingStaleFiles: number
	totalChunks: number
}

export interface SearchOptions {
	signal?: AbortSignal
	onProgress?: (progress: IndexProgress) => void
	/** Skip the pre-search freshness refresh entirely (e.g. while an explicit
	 *  /index build is running, to avoid two concurrent index writers). */
	skipRefresh?: boolean
}

export async function searchIndex(
	cwd: string,
	query: string,
	limit: number,
	options: SearchOptions = {},
): Promise<SearchOutcome> {
	const update = await updateIndex(cwd, {
		signal: options.signal,
		maxChangedFiles: options.skipRefresh ? 0 : MAX_STALE_FILES_PER_SEARCH,
		requireExisting: true,
		onProgress: options.onProgress,
	})
	const chunks = loadRuntimeChunks(cwd)
	const [queryVector] = await embedTexts([formatQueryForEmbedding(query)], { signal: options.signal })

	const queryTokens = query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length >= 3)

	const scored = chunks
		.map((chunk) => ({ chunk, score: dot(queryVector, chunk.vector) + lexicalBonus(queryTokens, chunk) }))
		.sort((a, b) => b.score - a.score)

	const perFile = new Map<string, number>()
	const results: SearchResult[] = []
	for (const { chunk, score } of scored) {
		const seen = perFile.get(chunk.file) ?? 0
		if (seen >= MAX_CHUNKS_PER_FILE) continue
		perFile.set(chunk.file, seen + 1)
		results.push({ file: chunk.file, startLine: chunk.startLine, endLine: chunk.endLine, score, text: chunk.text })
		if (results.length >= limit) break
	}

	return { results, pendingStaleFiles: update.pendingStaleFiles, totalChunks: chunks.length }
}
