/**
 * Memory management core — one grammar, two surfaces: the `kimchi memory`
 * CLI subcommand (commands/memory.ts) and the in-session `/memory` command
 * (index.ts). Parsing, rendering, and store discovery are pure (unit-tested
 * under Node); store operations go through an injectable backend factory.
 *
 * Deletion is user-only by design: the model keeps the read-only
 * memory_search tool, and nothing recalled from a store can engineer its
 * own deletion (the injection-resistance policy, docs/memory-extension.md).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { createMemoryBackend, defaultMemoryDir } from "./backend.js"
import { MEMORY_USER_ID } from "./config.js"
import { acquireCaptureLock } from "./lock.js"
import { resolveProjectScope, sanitizeScopeId } from "./scope.js"

// --- shared types -------------------------------------------------------------

/** One stored fact as management sees it. */
export interface AdminMemoryItem {
	id: string
	memory: string
	createdAt?: string
	updatedAt?: string
}

/** The narrow store surface management needs — the real backend adapts mem0. */
export interface AdminBackend {
	getAll(): Promise<AdminMemoryItem[]>
	search(query: string): Promise<Array<AdminMemoryItem & { score?: number }>>
	delete(id: string): Promise<void>
	deleteAll(): Promise<void>
}

export interface AdminStore {
	/** "personal" or the project scope id ("owner/name"). */
	scopeId: string
	kind: "personal" | "project"
	dbPath: string
}

/** Test seams — every fs/backend/lock boundary is injectable. */
export interface AdminDeps {
	memoryRoot?: string
	createBackend?: (dbPath: string) => Promise<AdminBackend>
	acquireLock?: (memoryRoot: string) => Promise<() => Promise<void>>
}

/** What one management invocation produced, ready for either surface. */
export interface AdminResult {
	text: string
	json: string
	code: number
	/** The surface shows .json instead of .text when the --json flag was passed. */
	useJson: boolean
}

export type ScopeFilter = { kind: "all" } | { kind: "personal" } | { kind: "project"; scopeId: string }

export type AdminCommand =
	| { op: "overview"; json: boolean }
	| { op: "list"; scope: ScopeFilter; limit: number | "all"; offset: number; json: boolean }
	| { op: "search"; query: string; scope: ScopeFilter; json: boolean }
	| { op: "delete"; ids: string[] }
	| { op: "reset"; scope: ScopeFilter; yes: boolean }
	| { op: "usage-error"; message: string }

export const USAGE = `usage: memory [list|search|delete|reset]

  (no arguments)   overview: storage path, per-store stats, pending jobs
  list    [--scope personal|project|all] [--project <owner/name>]
          [--limit N|all] [--offset N] [--json]
  search  <query> [--scope ...] [--json]
  delete  <id> [<id>...]
  reset   --scope all|personal|project [--project <owner/name>] [--yes]`

// --- grammar ------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set(["list", "search", "delete", "reset"])
const DEFAULT_LIST_LIMIT = 50

interface ParsedFlags {
	values: Record<string, string>
	bools: Set<string>
	positionals: string[]
}

const VALUE_FLAGS = new Set(["--scope", "--project", "--limit", "--offset"])

function parseFlagTokens(rest: string[]): ParsedFlags | { error: string } {
	const values: Record<string, string> = {}
	const bools = new Set<string>()
	const positionals: string[] = []
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string
		if (VALUE_FLAGS.has(token)) {
			const value = rest[++i]
			if (value === undefined) return { error: `${token} requires a value` }
			values[token.slice(2)] = value
		} else if (token === "--json") {
			bools.add("json")
		} else if (token === "--yes") {
			bools.add("yes")
		} else if (token.startsWith("--")) {
			return { error: `unknown flag ${token}` }
		} else {
			positionals.push(token)
		}
	}
	return { values, bools, positionals }
}

function parseNonNegativeInt(raw: string, flag: string): number | { error: string } {
	const value = Number(raw)
	if (!Number.isInteger(value) || value < 0) {
		return { error: `invalid ${flag} value ${JSON.stringify(raw)} — expected a non-negative integer` }
	}
	return value
}

function parseScopeFilter(
	flags: ParsedFlags,
	opts: { cwd: string },
	{ required }: { required: boolean },
): ScopeFilter | { error: string } {
	const raw = flags.values.scope
	if (raw === undefined) {
		if (required) return { error: `reset requires --scope (all, personal, or project)` }
		return { kind: "all" }
	}
	if (raw === "all") return { kind: "all" }
	if (raw === "personal") return { kind: "personal" }
	if (raw !== "project") {
		return { error: `invalid --scope ${JSON.stringify(raw)} — expected all, personal, or project` }
	}
	const project = flags.values.project
	if (project !== undefined) {
		const sanitized = sanitizeScopeId(project)
		if (!sanitized) return { error: `invalid --project id ${JSON.stringify(project)}` }
		return { kind: "project", scopeId: sanitized }
	}
	const resolved = resolveProjectScope(opts.cwd)
	if (!resolved) {
		return {
			error: "--scope project requires --project <owner/name> (or run inside a git repository)",
		}
	}
	return { kind: "project", scopeId: resolved.id }
}

/** Parse the management grammar. Pure — unit-tested under Node. */
export function parseAdminArgs(args: string[], opts: { cwd: string }): AdminCommand {
	const first = args[0] ?? ""
	if (first !== "" && !KNOWN_SUBCOMMANDS.has(first) && !first.startsWith("--")) {
		return { op: "usage-error", message: `unknown subcommand ${JSON.stringify(first)}` }
	}
	const sub = KNOWN_SUBCOMMANDS.has(first) ? first : ""
	const rest = sub === "" ? args : args.slice(1)
	const flags = parseFlagTokens(rest)
	if ("error" in flags) return { op: "usage-error", message: flags.error }
	const scope = parseScopeFilter(flags, opts, { required: sub === "reset" })
	if ("error" in scope) return { op: "usage-error", message: scope.error }

	if (sub === "" || sub === "list") {
		if (flags.positionals.length > 0) {
			return { op: "usage-error", message: `${sub === "" ? "overview" : "list"} takes no positional arguments` }
		}
	}

	switch (sub) {
		case "search": {
			const query = flags.positionals.join(" ")
			if (!query) return { op: "usage-error", message: "search requires a query" }
			return { op: "search", query, scope, json: flags.bools.has("json") }
		}
		case "delete": {
			if (flags.positionals.length === 0) {
				return { op: "usage-error", message: "delete requires at least one memory id (see `memory list`)" }
			}
			return { op: "delete", ids: [...flags.positionals] }
		}
		case "reset": {
			if (flags.positionals.length > 0) {
				return { op: "usage-error", message: "reset takes no positional arguments" }
			}
			return { op: "reset", scope, yes: flags.bools.has("yes") }
		}
		default: {
			// Bare `memory` (overview) or `memory list`.
			const limit: number | "all" | { error: string } =
				flags.values.limit === undefined
					? DEFAULT_LIST_LIMIT
					: flags.values.limit === "all"
						? "all"
						: parseNonNegativeInt(flags.values.limit, "--limit")
			if (typeof limit === "object") {
				return { op: "usage-error", message: limit.error }
			}
			let offset = 0
			if (flags.values.offset !== undefined) {
				const parsed = parseNonNegativeInt(flags.values.offset, "--offset")
				if (typeof parsed === "object") return { op: "usage-error", message: parsed.error }
				offset = parsed
			}
			return sub === "list"
				? { op: "list", scope, limit, offset, json: flags.bools.has("json") }
				: { op: "overview", json: flags.bools.has("json") }
		}
	}
}

// --- store discovery (fs) ------------------------------------------------------

export function listStores(memoryRoot: string): AdminStore[] {
	const stores: AdminStore[] = []
	const personalDb = join(memoryRoot, "personal", "memory.db")
	if (existsSync(personalDb)) {
		stores.push({ scopeId: "personal", kind: "personal", dbPath: personalDb })
	}
	const projectsRoot = join(memoryRoot, "projects")
	if (existsSync(projectsRoot)) {
		collectProjectStores(projectsRoot, projectsRoot, stores, 0)
	}
	return stores
}

/** Project scope ids are ≤4 slash-separated segments — bound the walk. */
function collectProjectStores(dir: string, projectsRoot: string, stores: AdminStore[], depth: number): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const sub = join(dir, entry.name)
		const dbPath = join(sub, "memory.db")
		if (existsSync(dbPath)) {
			const scopeId = relative(projectsRoot, sub).split(sep).join("/")
			stores.push({ scopeId, kind: "project", dbPath })
		} else if (depth < 4) {
			collectProjectStores(sub, projectsRoot, stores, depth + 1)
		}
	}
}

function selectStores(stores: AdminStore[], filter: ScopeFilter): AdminStore[] {
	if (filter.kind === "all") return stores
	if (filter.kind === "personal") return stores.filter((s) => s.kind === "personal")
	return stores.filter((s) => s.kind === "project" && s.scopeId === filter.scopeId)
}

// --- default backend (mem0 adapter) --------------------------------------------

async function defaultCreateBackend(dbPath: string): Promise<AdminBackend> {
	const mem0 = await createMemoryBackend({ dbPath })
	return {
		getAll: async () => {
			const { results } = await mem0.getAll({ filters: { user_id: MEMORY_USER_ID }, topK: 100_000 })
			return results
		},
		search: async (query) => {
			const raw = await mem0.search(query, { filters: { user_id: MEMORY_USER_ID }, topK: 20 })
			const list = (Array.isArray(raw) ? raw : (raw?.results ?? [])) as Array<{
				id?: string
				memory?: string
				score?: number
			}>
			return list.filter(
				(r): r is { id: string; memory: string; score?: number; createdAt?: string; updatedAt?: string } =>
					typeof r.id === "string" && typeof r.memory === "string",
			)
		},
		delete: async (id) => {
			await mem0.delete(id)
		},
		deleteAll: async () => {
			await mem0.deleteAll({ userId: MEMORY_USER_ID })
		},
	}
}

interface ResolvedDeps {
	memoryRoot: string
	createBackend: (dbPath: string) => Promise<AdminBackend>
	acquireLock: (memoryRoot: string) => Promise<() => Promise<void>>
}

function resolveDeps(deps?: AdminDeps): ResolvedDeps {
	return {
		memoryRoot: deps?.memoryRoot ?? defaultMemoryDir(),
		createBackend: deps?.createBackend ?? defaultCreateBackend,
		acquireLock: deps?.acquireLock ?? acquireCaptureLock,
	}
}

// --- rendering helpers (pure) ---------------------------------------------------

function truncateText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function recencyKey(item: AdminMemoryItem): string {
	return item.updatedAt ?? item.createdAt ?? ""
}

function sortNewestFirst<T extends AdminMemoryItem>(items: T[]): T[] {
	return items.sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
}

function noMemoriesLine(scope: ScopeFilter): string {
	if (scope.kind === "personal") return "No memories in the personal store yet."
	if (scope.kind === "project") return `No memories for project ${scope.scopeId} yet.`
	return "No memories stored yet."
}

function countDirEntries(dir: string): number {
	try {
		return readdirSync(dir).length
	} catch {
		// A missing directory is the normal empty state, not an error.
		return 0
	}
}

function ledgerEntryCount(path: string): number {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
		return Array.isArray(parsed) ? parsed.length : 0
	} catch {
		// A missing or corrupt ledger just means nothing captured yet.
		return 0
	}
}

/** A stored fact with the store it belongs to — what interactive surfaces need. */
export interface AdminFact extends AdminMemoryItem {
	scopeId: string
}

function renderFactLines(page: AdminFact[]): string[] {
	const scopeWidth = Math.max(8, ...page.map((p) => p.scopeId.length))
	return page.map((p) => {
		const date = recencyKey(p).slice(0, 10) || "-"
		return `  ${p.id}  ${p.scopeId.padEnd(scopeWidth)}  ${date.padEnd(10)}  ${truncateText(p.memory, 100)}`
	})
}

// --- operations ------------------------------------------------------------------

export interface AdminRunOptions {
	/** cwd for `--scope project` resolution. */
	cwd: string
	/** Pre-destructive confirm for reset — return false to abort. `--yes` skips it. */
	confirm?: (message: string) => Promise<boolean>
	/** Test seams. */
	deps?: AdminDeps
}

/**
 * Run one management invocation. Never throws — errors (and usage errors)
 * come back as a result with a nonzero code so both surfaces just print.
 */
export async function runAdminCommand(args: string[], options: AdminRunOptions): Promise<AdminResult> {
	const parsed = parseAdminArgs(args, { cwd: options.cwd })
	if (parsed.op === "usage-error") {
		return {
			text: `${parsed.message}\n\n${USAGE}`,
			json: JSON.stringify({ error: parsed.message }, null, 2),
			code: 1,
			useJson: false,
		}
	}
	const deps = resolveDeps(options.deps)
	// The --json flag selects the rendering at the surface; the ops always
	// produce both.
	const useJson = parsed.op !== "delete" && parsed.op !== "reset" ? parsed.json : false
	try {
		switch (parsed.op) {
			case "overview":
				return withMode(await opOverview(deps), useJson)
			case "list":
				return withMode(await opList(parsed, deps), useJson)
			case "search":
				return withMode(await opSearch(parsed, deps), useJson)
			case "delete":
				return withMode(await opDelete(parsed, deps), false)
			case "reset":
				return withMode(await opReset(parsed, options, deps), false)
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			text: `error: ${message}`,
			json: JSON.stringify({ error: message }, null, 2),
			code: 1,
			useJson: false,
		}
	}
}

function withMode(result: Omit<AdminResult, "useJson">, useJson: boolean): AdminResult {
	return { ...result, useJson }
}

function result(payload: { text: string; code?: number; data: unknown }): Omit<AdminResult, "useJson"> {
	return {
		text: payload.text,
		json: JSON.stringify(payload.data, null, 2),
		code: payload.code ?? 0,
	}
}

async function loadAllScoped(deps: ResolvedDeps, scope: ScopeFilter): Promise<AdminFact[]> {
	const items: AdminFact[] = []
	for (const store of selectStores(listStores(deps.memoryRoot), scope)) {
		const backend = await deps.createBackend(store.dbPath)
		for (const item of await backend.getAll()) items.push({ ...item, scopeId: store.scopeId })
	}
	return items
}

/** Interactive surfaces (memory-panel): every fact in the selected scopes, newest first. */
export async function adminListFacts(scope: ScopeFilter, deps?: AdminDeps): Promise<AdminFact[]> {
	return sortNewestFirst(await loadAllScoped(resolveDeps(deps), scope))
}

/** Interactive surfaces: ranked search hits in the selected scopes (needs the gateway for the query embedding). */
export async function adminSearchFacts(
	query: string,
	scope: ScopeFilter,
	deps?: AdminDeps,
): Promise<Array<AdminFact & { score?: number }>> {
	const resolved = resolveDeps(deps)
	const hits: Array<AdminFact & { score?: number }> = []
	for (const store of selectStores(listStores(resolved.memoryRoot), scope)) {
		const backend = await resolved.createBackend(store.dbPath)
		for (const hit of await backend.search(query)) hits.push({ ...hit, scopeId: store.scopeId })
	}
	hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
	return hits
}

/** Interactive surfaces: delete facts by id across all stores. Throws on backend failure. */
export async function adminDeleteFacts(
	ids: string[],
	deps?: AdminDeps,
): Promise<{ deleted: Array<{ id: string; scope: string }>; notFound: string[] }> {
	const resolved = resolveDeps(deps)
	const index = new Map<string, { scopeId: string; backend: AdminBackend }>()
	for (const store of listStores(resolved.memoryRoot)) {
		const backend = await resolved.createBackend(store.dbPath)
		for (const item of await backend.getAll()) index.set(item.id, { scopeId: store.scopeId, backend })
	}
	const deleted: Array<{ id: string; scope: string }> = []
	const notFound: string[] = []
	for (const id of ids) {
		const hit = index.get(id)
		if (!hit) {
			notFound.push(id)
			continue
		}
		await hit.backend.delete(id)
		deleted.push({ id, scope: hit.scopeId })
	}
	return { deleted, notFound }
}

async function opOverview(deps: ResolvedDeps): Promise<Omit<AdminResult, "useJson">> {
	const stores = listStores(deps.memoryRoot)
	const entries = await Promise.all(
		stores.map(async (store) => {
			const backend = await deps.createBackend(store.dbPath)
			return {
				scope: store.scopeId,
				facts: (await backend.getAll()).length,
				sizeBytes: statSync(store.dbPath).size,
			}
		}),
	)
	const pendingJobs = countDirEntries(join(deps.memoryRoot, "pending"))
	const ledgerEntries = ledgerEntryCount(join(deps.memoryRoot, "captured-hashes.json"))
	const data = { root: deps.memoryRoot, stores: entries, pendingJobs, ledgerEntries }

	const lines = [`Memory storage: ${deps.memoryRoot}`, ""]
	if (entries.length === 0) {
		lines.push("No memories stored yet.")
	} else {
		const scopeWidth = Math.max(5, ...entries.map((e) => e.scope.length))
		lines.push(`  ${"scope".padEnd(scopeWidth)}  facts    size`)
		for (const entry of entries) {
			lines.push(
				`  ${entry.scope.padEnd(scopeWidth)}  ${String(entry.facts).padEnd(8)}  ${formatSize(entry.sizeBytes)}`,
			)
		}
	}
	lines.push("", `Pending capture jobs: ${pendingJobs}`, `Captured-message ledger entries: ${ledgerEntries}`, "", USAGE)
	return result({ text: lines.join("\n"), data })
}

async function opList(
	parsed: { scope: ScopeFilter; limit: number | "all"; offset: number },
	deps: ResolvedDeps,
): Promise<Omit<AdminResult, "useJson">> {
	const all = await adminListFacts(parsed.scope, deps)
	const total = all.length
	const page =
		parsed.limit === "all" ? all.slice(parsed.offset) : all.slice(parsed.offset, parsed.offset + parsed.limit)
	const data = {
		total,
		offset: parsed.offset,
		limit: parsed.limit,
		scope: parsed.scope,
		facts: page.map(({ scopeId, ...item }) => ({ scope: scopeId, ...item })),
	}

	if (total === 0) return result({ text: noMemoriesLine(parsed.scope), data })
	if (page.length === 0) {
		return result({
			text: `No facts on this page — offset ${parsed.offset} is past the last fact (total ${total}).`,
			data,
		})
	}
	const end = parsed.offset + page.length
	const next = parsed.limit !== "all" && end < total ? ` — use --offset ${end} for the next page` : ""
	const header = `showing ${parsed.offset + 1}–${end} of ${total}${next}`
	return result({ text: [header, "", ...renderFactLines(page)].join("\n"), data })
}

async function opSearch(
	parsed: { query: string; scope: ScopeFilter },
	deps: ResolvedDeps,
): Promise<Omit<AdminResult, "useJson">> {
	const hits = await adminSearchFacts(parsed.query, parsed.scope, deps)
	const data = {
		query: parsed.query,
		scope: parsed.scope,
		results: hits.map(({ scopeId, ...item }) => ({ scope: scopeId, ...item })),
	}

	if (hits.length === 0) return result({ text: `No memories match ${JSON.stringify(parsed.query)}.`, data })
	const scopeWidth = Math.max(8, ...hits.map((h) => h.scopeId.length))
	const lines = hits.map((h) => {
		const score = h.score === undefined ? "?" : h.score.toFixed(3)
		return `  ${score.padEnd(6)}  ${h.scopeId.padEnd(scopeWidth)}  ${truncateText(h.memory, 100)}`
	})
	return result({ text: lines.join("\n"), data })
}

async function opDelete(parsed: { ids: string[] }, deps: ResolvedDeps): Promise<Omit<AdminResult, "useJson">> {
	const { deleted, notFound } = await adminDeleteFacts(parsed.ids, deps)
	const data = { deleted, notFound }
	const lines = deleted.map((d) => `Deleted ${d.id} from ${d.scope}.`)
	if (notFound.length > 0) lines.push(`Not found: ${notFound.join(", ")}`)
	return result({ text: lines.join("\n"), data, code: notFound.length > 0 ? 1 : 0 })
}

async function opReset(
	parsed: { scope: ScopeFilter; yes: boolean },
	options: AdminRunOptions,
	deps: ResolvedDeps,
): Promise<Omit<AdminResult, "useJson">> {
	const cancelled: Omit<AdminResult, "useJson"> = {
		text: "Cancelled.",
		json: JSON.stringify({ cancelled: true }, null, 2),
		code: 1,
	}

	if (parsed.scope.kind === "all") {
		const stores = listStores(deps.memoryRoot)
		const storeCounts = await Promise.all(
			stores.map(async (store) => {
				const backend = await deps.createBackend(store.dbPath)
				return (await backend.getAll()).length
			}),
		)
		const facts = storeCounts.reduce((a, b) => a + b, 0)
		const pendingJobs = countDirEntries(join(deps.memoryRoot, "pending"))
		if (!parsed.yes && !options.confirm) {
			return {
				text: "error: reset --scope all requires --yes or an interactive confirmation",
				json: JSON.stringify({ error: "confirmation required" }, null, 2),
				code: 1,
			}
		}
		if (
			!parsed.yes &&
			!(await options.confirm?.(
				`Wipe ALL memory? This permanently deletes ${stores.length} store(s), ${facts} fact(s), and ${pendingJobs} pending capture job(s).`,
			))
		) {
			return cancelled
		}
		const release = await deps.acquireLock(deps.memoryRoot)
		try {
			// The held lock lives on capture.lock (+ its .lock directory) —
			// wiping them under the lock would break release.
			for (const entry of readdirSync(deps.memoryRoot)) {
				if (entry === "capture.lock" || entry === "capture.lock.lock") continue
				rmSync(join(deps.memoryRoot, entry), { recursive: true, force: true })
			}
		} finally {
			await release()
		}
		return result({
			text: `Wiped the memory root: ${stores.length} store(s), ${facts} fact(s), ${pendingJobs} pending job(s) removed.`,
			data: { scope: "all", stores: stores.length, facts, pendingJobs },
		})
	}

	const scopeId = parsed.scope.kind === "personal" ? "personal" : parsed.scope.scopeId
	const store = listStores(deps.memoryRoot).find((s) => s.scopeId === scopeId)
	if (!store) {
		return result({
			text: `No memory store for ${scopeId} — nothing to reset.`,
			data: { scope: scopeId, error: "no such store" },
			code: 1,
		})
	}
	const backend = await deps.createBackend(store.dbPath)
	const facts = (await backend.getAll()).length
	if (!parsed.yes && !options.confirm) {
		return {
			text: "error: reset requires --yes or an interactive confirmation",
			json: JSON.stringify({ error: "confirmation required" }, null, 2),
			code: 1,
		}
	}
	if (
		!parsed.yes &&
		!(await options.confirm?.(`Reset the ${scopeId} store? This permanently deletes ${facts} fact(s).`))
	) {
		return cancelled
	}
	const release = await deps.acquireLock(deps.memoryRoot)
	try {
		await backend.deleteAll()
	} finally {
		await release()
	}
	return result({
		text: `Reset ${scopeId}: deleted ${facts} fact(s).`,
		data: { scope: scopeId, facts },
	})
}
