import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AdminBackend, type AdminMemoryItem, listStores, parseAdminArgs, runAdminCommand } from "./admin.js"

// --- fixtures -------------------------------------------------------------------

const fact = (id: string, memory: string, createdAt?: string): AdminMemoryItem => ({
	id,
	memory,
	createdAt,
})

/** A non-repo cwd so --scope project never resolves accidentally. */
const NO_REPO_CWD = join(tmpdir(), "kimchi-memory-admin-norepo")

function makeFakeBackend(items: AdminMemoryItem[]) {
	const deleted: string[] = []
	let deletedAll = false
	const backend: AdminBackend = {
		getAll: async () => items,
		search: async (query) =>
			items
				.filter((i) => i.memory.toLowerCase().includes(query.toLowerCase()))
				.map((i, n) => ({ ...i, score: 0.9 - n * 0.1 })),
		delete: async (id) => {
			deleted.push(id)
		},
		deleteAll: async () => {
			deletedAll = true
		},
	}
	return { backend, deleted, isDeletedAll: () => deletedAll }
}

/** Seed a memory root with stores and fake backends, keyed by scope id. */
function harness(stores: Record<string, AdminMemoryItem[]>, cwd = NO_REPO_CWD) {
	const root = mkdtempSync(join(tmpdir(), "kimchi-memory-admin-"))
	const backends = new Map<string, ReturnType<typeof makeFakeBackend>>()
	for (const [scopeId, items] of Object.entries(stores)) {
		const dir = scopeId === "personal" ? join(root, "personal") : join(root, "projects", scopeId)
		mkdirSync(dir, { recursive: true })
		const dbPath = join(dir, "memory.db")
		writeFileSync(dbPath, "")
		backends.set(dbPath, makeFakeBackend(items))
	}
	const run = (args: string[]) =>
		runAdminCommand(args, {
			cwd,
			deps: {
				memoryRoot: root,
				createBackend: (dbPath) => Promise.resolve(backends.get(dbPath)?.backend ?? makeFakeBackend([]).backend),
				acquireLock: () => Promise.resolve(() => Promise.resolve()),
			},
		})
	return { root, backends, run }
}

const roots: string[] = []
function trackedHarness(stores: Record<string, AdminMemoryItem[]>, cwd?: string) {
	const h = harness(stores, cwd)
	roots.push(h.root)
	return h
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop()
		if (root) rmSync(root, { recursive: true, force: true })
	}
})

// --- parseAdminArgs (pure grammar) ----------------------------------------------

describe("parseAdminArgs", () => {
	it("bare invocation and --json parse as the overview", () => {
		expect(parseAdminArgs([], { cwd: NO_REPO_CWD })).toEqual({ op: "overview", json: false })
		expect(parseAdminArgs(["--json"], { cwd: NO_REPO_CWD })).toEqual({ op: "overview", json: true })
	})

	it("list defaults: all scopes, limit 50, offset 0", () => {
		expect(parseAdminArgs(["list"], { cwd: NO_REPO_CWD })).toEqual({
			op: "list",
			scope: { kind: "all" },
			limit: 50,
			offset: 0,
			json: false,
		})
	})

	it("list parses --limit all / N, --offset N, and --scope personal", () => {
		expect(parseAdminArgs(["list", "--limit", "all"], { cwd: NO_REPO_CWD })).toMatchObject({ limit: "all" })
		expect(parseAdminArgs(["list", "--limit", "10", "--offset", "5"], { cwd: NO_REPO_CWD })).toMatchObject({
			limit: 10,
			offset: 5,
		})
		expect(parseAdminArgs(["list", "--scope", "personal"], { cwd: NO_REPO_CWD })).toMatchObject({
			scope: { kind: "personal" },
		})
	})

	it("rejects invalid --limit and --offset values", () => {
		expect(parseAdminArgs(["list", "--limit", "-3"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["list", "--limit", "abc"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["list", "--offset", "1.5"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
	})

	it("project scope takes --project explicitly or resolves from a git cwd", () => {
		expect(parseAdminArgs(["list", "--scope", "project", "--project", "owner/name"], { cwd: NO_REPO_CWD })).toEqual({
			op: "list",
			scope: { kind: "project", scopeId: "owner/name" },
			limit: 50,
			offset: 0,
			json: false,
		})
		// No --project and no repository at cwd → clear usage error.
		expect(parseAdminArgs(["list", "--scope", "project"], { cwd: NO_REPO_CWD })).toMatchObject({
			op: "usage-error",
		})
	})

	it("search joins positional words into the query", () => {
		expect(parseAdminArgs(["search", "dog", "name"], { cwd: NO_REPO_CWD })).toMatchObject({ query: "dog name" })
		expect(parseAdminArgs(["search"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
	})

	it("delete collects positional ids; reset requires --scope", () => {
		expect(parseAdminArgs(["delete", "a", "b"], { cwd: NO_REPO_CWD })).toEqual({ op: "delete", ids: ["a", "b"] })
		expect(parseAdminArgs(["delete"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["reset"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["reset", "--scope", "all", "--yes"], { cwd: NO_REPO_CWD })).toEqual({
			op: "reset",
			scope: { kind: "all" },
			yes: true,
		})
	})

	it("rejects unknown subcommands, unknown flags, and stray positionals", () => {
		expect(parseAdminArgs(["lst"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["list", "--bogus"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["list", "extra"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
		expect(parseAdminArgs(["--scope"], { cwd: NO_REPO_CWD })).toMatchObject({ op: "usage-error" })
	})
})

// --- listStores (fs discovery) ----------------------------------------------------

describe("listStores", () => {
	it("discovers the personal store and nested project stores", () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-memory-admin-"))
		roots.push(root)
		mkdirSync(join(root, "personal"), { recursive: true })
		writeFileSync(join(root, "personal", "memory.db"), "")
		mkdirSync(join(root, "projects", "a", "b"), { recursive: true })
		writeFileSync(join(root, "projects", "a", "b", "memory.db"), "")
		mkdirSync(join(root, "projects", "x", "y", "z"), { recursive: true })
		writeFileSync(join(root, "projects", "x", "y", "z", "memory.db"), "")
		// A project dir without a store is skipped.
		mkdirSync(join(root, "projects", "empty"), { recursive: true })

		const stores = listStores(root)
		expect(stores.map((s) => s.scopeId).sort()).toEqual(["a/b", "personal", "x/y/z"])
		expect(stores.find((s) => s.scopeId === "a/b")?.kind).toBe("project")
		expect(stores.find((s) => s.scopeId === "personal")?.kind).toBe("personal")
	})

	it("an empty root has no stores", () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-memory-admin-"))
		roots.push(root)
		expect(listStores(root)).toEqual([])
	})
})

// --- runAdminCommand (ops with fake backends) ---------------------------------------

describe("runAdminCommand — list", () => {
	it("lists across stores, newest first, with pagination", async () => {
		const h = trackedHarness({
			personal: [fact("p1", "older personal fact", "2026-09-10"), fact("p2", "newest fact", "2026-09-11")],
			"a/b": [fact("q1", "project fact", "2026-09-10T12:00:00Z")],
		})
		const result = await h.run(["list"])
		expect(result.code).toBe(0)
		expect(result.text).toContain("showing 1–3 of 3")
		expect(result.text).toContain("newest fact")
		expect(result.text).toContain("personal")
		expect(result.text).toContain("a/b")
		// Newest first: the newest fact's line appears before the older one's.
		expect(result.text.indexOf("newest fact")).toBeLessThan(result.text.indexOf("older personal fact"))
	})

	it("paginates and hints at the next page", async () => {
		const items = Array.from({ length: 6 }, (_, i) => fact(`id-${i}`, `fact ${i}`, `2026-09-0${i + 1}`))
		const h = trackedHarness({ personal: items })
		const page1 = await h.run(["list", "--limit", "5"])
		expect(page1.text).toContain("showing 1–5 of 6")
		expect(page1.text).toContain("--offset 5 for the next page")
		// Newest first: page 1 carries facts 5..1; the oldest is on page 2.
		expect(page1.text).toContain("fact 5")
		expect(page1.text).not.toContain("fact 0")
		const page2 = await h.run(["list", "--limit", "5", "--offset", "5"])
		expect(page2.text).toContain("showing 6–6 of 6")
		expect(page2.text).toContain("fact 0")
		// --limit all shows everything.
		const all = await h.run(["list", "--limit", "all"])
		expect(all.text).toContain("showing 1–6 of 6")
	})

	it("empty stores render the normal empty state, never an error", async () => {
		const h = trackedHarness({})
		const all = await h.run(["list"])
		expect(all.code).toBe(0)
		expect(all.text).toBe("No memories stored yet.")
		const personal = await h.run(["list", "--scope", "personal"])
		expect(personal.text).toBe("No memories in the personal store yet.")
		const project = await h.run(["list", "--scope", "project", "--project", "no/such"])
		expect(project.text).toBe("No memories for project no/such yet.")
	})

	it("--json produces parseable output and sets useJson", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact", "2026-09-11")] })
		const result = await h.run(["list", "--json"])
		expect(result.useJson).toBe(true)
		const data = JSON.parse(result.json) as { total: number; facts: Array<{ id: string; scope: string }> }
		expect(data.total).toBe(1)
		expect(data.facts[0]).toMatchObject({ id: "p1", scope: "personal" })
	})
})

describe("runAdminCommand — search", () => {
	it("returns matching facts with scores across stores", async () => {
		const h = trackedHarness({
			personal: [fact("p1", "the user's dog is named Fred")],
			"a/b": [fact("q1", "the repo uses vitest")],
		})
		const result = await h.run(["search", "dog"])
		expect(result.code).toBe(0)
		expect(result.text).toContain("Fred")
		expect(result.text).not.toContain("vitest")
	})

	it("no matches is the normal empty state", async () => {
		const h = trackedHarness({ personal: [fact("p1", "unrelated")] })
		const result = await h.run(["search", "quantum"])
		expect(result.code).toBe(0)
		expect(result.text).toBe('No memories match "quantum".')
	})
})

describe("runAdminCommand — delete", () => {
	it("deletes ids across stores without needing --scope", async () => {
		const h = trackedHarness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		const result = await h.run(["delete", "p1", "q1"])
		expect(result.code).toBe(0)
		expect(result.text).toContain("Deleted p1 from personal.")
		expect(result.text).toContain("Deleted q1 from a/b.")
		const personalBackend = [...h.backends.entries()].find(([path]) => path.includes("personal"))?.[1]
		const projectBackend = [...h.backends.entries()].find(([path]) => path.includes("projects"))?.[1]
		expect(personalBackend?.deleted).toEqual(["p1"])
		expect(projectBackend?.deleted).toEqual(["q1"])
	})

	it("unknown ids are reported and exit nonzero", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact")] })
		const result = await h.run(["delete", "p1", "missing"])
		expect(result.code).toBe(1)
		expect(result.text).toContain("Deleted p1 from personal.")
		expect(result.text).toContain("Not found: missing")
	})
})

describe("runAdminCommand — reset", () => {
	it("resetting a scope wipes only that store after confirmation", async () => {
		const h = trackedHarness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		const confirm = vi.fn(async () => true)
		const result = await runAdminCommand(["reset", "--scope", "personal"], {
			cwd: NO_REPO_CWD,
			confirm,
			deps: {
				memoryRoot: h.root,
				createBackend: (dbPath) => Promise.resolve(h.backends.get(dbPath)?.backend ?? makeFakeBackend([]).backend),
				acquireLock: () => Promise.resolve(() => Promise.resolve()),
			},
		})
		expect(result.code).toBe(0)
		expect(result.text).toBe("Reset personal: deleted 1 fact(s).")
		const personalBackend = [...h.backends.entries()].find(([path]) => path.includes("personal"))?.[1]
		const projectBackend = [...h.backends.entries()].find(([path]) => path.includes("projects"))?.[1]
		expect(personalBackend?.isDeletedAll()).toBe(true)
		expect(projectBackend?.isDeletedAll()).toBe(false)
	})

	it("a declined confirmation cancels without touching stores", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact")] })
		const result = await runAdminCommand(["reset", "--scope", "personal"], {
			cwd: NO_REPO_CWD,
			confirm: async () => false,
			deps: {
				memoryRoot: h.root,
				createBackend: (dbPath) => Promise.resolve(h.backends.get(dbPath)?.backend ?? makeFakeBackend([]).backend),
				acquireLock: () => Promise.resolve(() => Promise.resolve()),
			},
		})
		expect(result.code).toBe(1)
		expect(result.text).toBe("Cancelled.")
		expect([...h.backends.values()][0]?.isDeletedAll()).toBe(false)
	})

	it("reset requires --yes when no interactive confirm is available", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact")] })
		const result = await h.run(["reset", "--scope", "personal"])
		expect(result.code).toBe(1)
		expect(result.text).toContain("requires --yes")
		// --yes proceeds without any confirm callback.
		const yes = await h.run(["reset", "--scope", "personal", "--yes"])
		expect(yes.code).toBe(0)
		expect(yes.text).toBe("Reset personal: deleted 1 fact(s).")
	})

	it("resetting a missing project store is a clear no-op error", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact")] })
		const result = await h.run(["reset", "--scope", "project", "--project", "no/such", "--yes"])
		expect(result.code).toBe(1)
		expect(result.text).toContain("No memory store for no/such")
	})

	it("reset --scope all wipes the memory root except the lock artifacts", async () => {
		const h = trackedHarness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		// Ledger, a pending job, and the lock artifacts a live root would have.
		writeFileSync(join(h.root, "captured-hashes.json"), "[]")
		mkdirSync(join(h.root, "pending"), { recursive: true })
		writeFileSync(join(h.root, "pending", "job.json"), "{}")
		writeFileSync(join(h.root, "capture.lock"), "")
		mkdirSync(join(h.root, "capture.lock.lock"), { recursive: true })

		const result = await h.run(["reset", "--scope", "all", "--yes"])
		expect(result.code).toBe(0)
		expect(result.text).toContain("2 store(s)")
		expect(result.text).toContain("2 fact(s)")
		expect(result.text).toContain("1 pending job(s)")
		// Everything except the lock artifacts is gone.
		expect(readdirSync(h.root).sort()).toEqual(["capture.lock", "capture.lock.lock"])
		expect(existsSync(join(h.root, "personal"))).toBe(false)
		expect(existsSync(join(h.root, "projects"))).toBe(false)
	})
})

describe("runAdminCommand — overview and usage errors", () => {
	it("the overview reports stores, sizes, pending jobs, and the ledger", async () => {
		const h = trackedHarness({ personal: [fact("p1", "a fact")] })
		writeFileSync(join(h.root, "captured-hashes.json"), '["h1", "h2"]')
		const result = await h.run([])
		expect(result.code).toBe(0)
		expect(result.text).toContain(h.root)
		expect(result.text).toContain("personal")
		expect(result.text).toMatch(/personal\s+1\b/)
		expect(result.text).toContain("Captured-message ledger entries: 2")
		expect(result.text).toContain("usage: memory")
	})

	it("usage errors exit nonzero with the usage text", async () => {
		const h = trackedHarness({})
		const result = await h.run(["bogus"])
		expect(result.code).toBe(1)
		expect(result.text).toContain('unknown subcommand "bogus"')
		expect(result.text).toContain("usage: memory")
	})
})
