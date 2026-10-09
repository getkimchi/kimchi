// Unit tests for the `_kimchi.dev/memory_*` ACP extension method handlers —
// the client-built /memory surface. Store operations run against fake
// backends in a temp memory root (the admin.test.ts harness pattern); the
// feature-resource state is isolated through a temp KIMCHI_CODING_AGENT_DIR.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestError } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AdminBackend, AdminMemoryItem } from "../../../extensions/memory/admin.js"
import { resolveProjectScope } from "../../../extensions/memory/scope.js"
import { getSessionMemoryOverride, setSessionMemoryOverride } from "../../../extensions/memory/session-toggle.js"
import { BaseFakeAgentSession, makeAcpConn, makeAcpSessionFactory } from "../__mocks__/fake-agent-session.js"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { KimchiAcpAgent } from "../server.js"
import {
	handleMemoryDelete,
	handleMemoryList,
	handleMemoryReset,
	handleMemorySearch,
	handleMemoryStatus,
	handleSetMemoryEnabled,
	type MemoryMethodOptions,
} from "./memory.js"

/** Runs fn, returns the thrown RequestError, or fails the test if nothing threw. */
function thrownRequestError(fn: () => unknown): RequestError {
	try {
		fn()
	} catch (error) {
		return error as RequestError
	}
	throw new Error("expected the call to throw a RequestError")
}

async function thrownRequestErrorAsync(fn: () => Promise<unknown>): Promise<RequestError> {
	try {
		await fn()
	} catch (error) {
		return error as RequestError
	}
	throw new Error("expected the call to throw a RequestError")
}

const fact = (id: string, memory: string, createdAt?: string): AdminMemoryItem => ({ id, memory, createdAt })

class FakeAgentSession extends BaseFakeAgentSession {}

// --- fixtures -------------------------------------------------------------------

const NO_REPO_CWD = join(tmpdir(), "kimchi-acp-memory-norepo")

/** A throwaway git repository cwd for local-scope resolution (the admin.test.ts pattern). */
function makeRepo(remote?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-acp-memory-repo-"))
	roots.push(dir)
	const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" })
	run(["init", "--quiet"])
	if (remote) run(["remote", "add", "origin", remote])
	return dir
}

/** A minimal session carrying the sessionManager identity the handlers key on. */
function makeSession(): { session: AgentSession; manager: object } {
	const manager = {}
	const session = { sessionManager: manager } as unknown as AgentSession
	return { session, manager }
}

function makeFakeBackend(items: AdminMemoryItem[]) {
	const deleted: string[] = []
	let deletedAll = false
	const backend: AdminBackend = {
		getAll: async () => items,
		search: async (query: string) =>
			items
				.filter((i) => i.memory.toLowerCase().includes(query.toLowerCase()))
				.map((i, n) => ({ ...i, score: 0.9 - n * 0.1 })),
		delete: async (id: string) => {
			deleted.push(id)
		},
		deleteAll: async () => {
			deletedAll = true
		},
	}
	return { backend, deleted, isDeletedAll: () => deletedAll }
}

/** Seed a memory root with stores and fake backends, keyed by db path. */
function harness(stores: Record<string, AdminMemoryItem[]>) {
	const root = mkdtempSync(join(tmpdir(), "kimchi-acp-memory-"))
	roots.push(root)
	const backends = new Map<string, ReturnType<typeof makeFakeBackend>>()
	for (const [scopeId, items] of Object.entries(stores)) {
		const dir = scopeId === "personal" ? join(root, "personal") : join(root, "projects", scopeId)
		mkdirSync(dir, { recursive: true })
		const dbPath = join(dir, "memory.db")
		writeFileSync(dbPath, "")
		backends.set(dbPath, makeFakeBackend(items))
	}
	const options: MemoryMethodOptions = {
		deps: {
			memoryRoot: root,
			createBackend: (dbPath) => Promise.resolve(backends.get(dbPath)?.backend ?? makeFakeBackend([]).backend),
			acquireLock: () => Promise.resolve(() => Promise.resolve()),
		},
		cwd: NO_REPO_CWD,
	}
	return { root, backends, options }
}

const roots: string[] = []
const realAgentDir = process.env.KIMCHI_CODING_AGENT_DIR

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop()
		if (root) rmSync(root, { recursive: true, force: true })
	}
	if (realAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = realAgentDir
})

/** Temp harness settings with the memory feature enabled or disabled. */
function setFeatureEnabled(enabled: boolean): void {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-acp-memory-settings-"))
	roots.push(dir)
	process.env.KIMCHI_CODING_AGENT_DIR = dir
	if (enabled) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ resources: { "extensions.memory": true } }))
	}
}

// --- memory_status --------------------------------------------------------------

describe("handleMemoryStatus", () => {
	it("reports both control layers plus the store overview", async () => {
		setFeatureEnabled(true)
		const { session, manager } = makeSession()
		const { options } = harness({ personal: [fact("p1", "a fact", "2026-09-11")] })

		const result = (await handleMemoryStatus((id) => (id === "s1" ? session : undefined), options, {
			sessionId: "s1",
		})) as {
			featureEnabled: boolean
			sessionOverride: boolean | null
			sessionActive: boolean
			root: string
			stores: Array<{ scope: string; facts: number }>
			pendingJobs: number
		}
		expect(result.featureEnabled).toBe(true)
		expect(result.sessionOverride).toBeNull()
		expect(result.sessionActive).toBe(true)
		expect(result.stores).toEqual([{ scope: "personal", facts: 1, sizeBytes: 0 }])
		expect(result.pendingJobs).toBe(0)

		// The toggle state follows the shared override keyed by the session's
		// manager — exactly what set_memory_enabled writes.
		setSessionMemoryOverride(manager, false)
		const after = (await handleMemoryStatus((id) => (id === "s1" ? session : undefined), options, {
			sessionId: "s1",
		})) as { sessionOverride: boolean | null; sessionActive: boolean }
		expect(after.sessionOverride).toBe(false)
		expect(after.sessionActive).toBe(false)
	})

	it("reports the feature resource as disabled without a settings override", async () => {
		setFeatureEnabled(false)
		const { session } = makeSession()
		const { options } = harness({})
		const result = (await handleMemoryStatus((id) => (id === "s1" ? session : undefined), options, {
			sessionId: "s1",
		})) as { featureEnabled: boolean; sessionActive: boolean; sessionOverride: boolean | null }
		expect(result.featureEnabled).toBe(false)
		// The conjunction: no memory runtime is loaded, so the session is not
		// active even though no override exists.
		expect(result.sessionActive).toBe(false)
		expect(result.sessionOverride).toBeNull()
	})

	it("rejects an unknown or missing session", async () => {
		const { options } = harness({})
		const unknown = await thrownRequestErrorAsync(() =>
			handleMemoryStatus(() => undefined, options, { sessionId: "nope" }),
		)
		expect(unknown.code).toBe(-32602)
		expect(unknown.message).toContain("unknown sessionId nope")

		const missing = await thrownRequestErrorAsync(() => handleMemoryStatus(() => undefined, options, {}))
		expect(missing.code).toBe(-32602)
		expect(missing.message).toContain("sessionId")
	})
})

// --- set_memory_enabled ----------------------------------------------------------

describe("handleSetMemoryEnabled", () => {
	it("flips the shared session toggle and echoes the value", () => {
		setFeatureEnabled(true)
		const { session, manager } = makeSession()
		const result = handleSetMemoryEnabled((id) => (id === "s1" ? session : undefined), {
			sessionId: "s1",
			enabled: false,
		})
		expect(result).toEqual({ sessionId: "s1", enabled: false })
		expect(getSessionMemoryOverride(manager)).toBe(false)
	})

	it("rejects a mistyped enabled and an unknown session", () => {
		setFeatureEnabled(true)
		const { session } = makeSession()
		const getSession = (id: string) => (id === "s1" ? session : undefined)
		const typed = thrownRequestError(() => handleSetMemoryEnabled(getSession, { sessionId: "s1" }))
		expect(typed.code).toBe(-32602)
		expect(typed.message).toContain("enabled")

		const unknown = thrownRequestError(() => handleSetMemoryEnabled(getSession, { sessionId: "other", enabled: true }))
		expect(unknown.code).toBe(-32602)
		expect(unknown.message).toContain("unknown sessionId other")
	})

	it("rejects the call when the memory feature resource is off", () => {
		setFeatureEnabled(false)
		const { session, manager } = makeSession()
		const err = thrownRequestError(() => handleSetMemoryEnabled(() => session, { sessionId: "s1", enabled: true }))
		expect(err.code).toBe(-32602)
		expect(err.message).toContain("memory feature is disabled")
		// Nothing was written — no runtime would ever read the flag.
		expect(getSessionMemoryOverride(manager)).toBeUndefined()
	})
})

// --- memory_list -----------------------------------------------------------------

describe("handleMemoryList", () => {
	it("lists facts with the default pagination, newest first", async () => {
		const { options } = harness({
			personal: [fact("p1", "older fact", "2026-09-10"), fact("p2", "newest fact", "2026-09-11")],
			"a/b": [fact("q1", "project fact", "2026-09-10T12:00:00Z")],
		})
		const result = (await handleMemoryList(options, { scope: "all" })) as {
			total: number
			offset: number
			limit: number
			facts: Array<{ id: string; scope: string; memory: string }>
		}
		expect(result.total).toBe(3)
		expect(result.offset).toBe(0)
		expect(result.limit).toBe(50)
		expect(result.facts.map((f) => f.id)).toEqual(["p2", "q1", "p1"]) // newest first
		expect(result.facts[0]).toMatchObject({ scope: "personal", memory: "newest fact" })
	})

	it("paginates with limit/offset and supports all", async () => {
		const items = Array.from({ length: 6 }, (_, i) => fact(`id-${i}`, `fact ${i}`, `2026-09-0${i + 1}`))
		const { options } = harness({ personal: items })
		const page1 = (await handleMemoryList(options, { scope: "personal", limit: 2 })) as {
			total: number
			facts: Array<{ id: string }>
		}
		expect(page1.facts.map((f) => f.id)).toEqual(["id-5", "id-4"])
		const page2 = (await handleMemoryList(options, { scope: "personal", limit: 2, offset: 2 })) as {
			facts: Array<{ id: string }>
		}
		expect(page2.facts.map((f) => f.id)).toEqual(["id-3", "id-2"])
		const all = (await handleMemoryList(options, { scope: "personal", limit: "all" })) as {
			facts: Array<{ id: string }>
		}
		expect(all.facts).toHaveLength(6)
	})

	it("scope params map through the shared grammar semantics", async () => {
		const { options } = harness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		const personal = (await handleMemoryList(options, { scope: "personal" })) as {
			facts: Array<{ memory: string }>
		}
		expect(personal.facts.map((f) => f.memory)).toEqual(["personal fact"])
		const project = (await handleMemoryList(options, { scope: "project", project: "a/b" })) as {
			facts: Array<{ memory: string }>
		}
		expect(project.facts.map((f) => f.memory)).toEqual(["project fact"])
	})

	it("a client-supplied cwd anchors the local scope; without one it stays personal-only", async () => {
		const repo = makeRepo("https://github.com/cur/proj.git")
		const stores: Record<string, AdminMemoryItem[]> = {
			personal: [fact("p1", "personal fact")],
			"cur/proj": [fact("q1", "client cwd project fact")],
		}
		// Whatever project the server process's cwd resolves to (the test
		// runner's own repo) — the old process.cwd() fallback would leak this
		// store into an unanchored local listing.
		const processScopeId = resolveProjectScope(process.cwd())?.id
		if (processScopeId) stores[processScopeId] = [fact("x1", "server cwd project fact")]
		const { options } = harness(stores)

		// With the client cwd: personal + that project — the workspace-equivalent view.
		const withCwd = (await handleMemoryList({ deps: options.deps }, { cwd: repo })) as {
			facts: Array<{ memory: string }>
		}
		expect(withCwd.facts.map((f) => f.memory).sort()).toEqual(["client cwd project fact", "personal fact"])

		// Without any cwd: personal-only — never the server process cwd's project.
		const without = (await handleMemoryList({ deps: options.deps }, {})) as {
			facts: Array<{ memory: string }>
		}
		expect(without.facts.map((f) => f.memory)).toEqual(["personal fact"])

		// A mistyped cwd is rejected.
		const err = await thrownRequestErrorAsync(() => handleMemoryList({ deps: options.deps }, { cwd: 42 }))
		expect(err.code).toBe(-32602)
		expect(err.message).toContain("cwd")
	})

	it("rejects invalid scope combinations and pagination params", async () => {
		const { options } = harness({})
		const badScope = await thrownRequestErrorAsync(() => handleMemoryList(options, { scope: "bogus" }))
		expect(badScope.code).toBe(-32602)
		expect(badScope.message).toContain("invalid --scope")

		const orphanProject = await thrownRequestErrorAsync(() => handleMemoryList(options, { project: "a/b" }))
		expect(orphanProject.code).toBe(-32602)
		expect(orphanProject.message).toContain("--project requires --scope project")

		const badLimit = await thrownRequestErrorAsync(() => handleMemoryList(options, { limit: -3 }))
		expect(badLimit.code).toBe(-32602)
		expect(badLimit.message).toContain("limit")

		const badOffset = await thrownRequestErrorAsync(() => handleMemoryList(options, { offset: 1.5 }))
		expect(badOffset.code).toBe(-32602)
		expect(badOffset.message).toContain("offset")
	})
})

// --- memory_search ----------------------------------------------------------------

describe("handleMemorySearch", () => {
	it("returns ranked hits with scores across the selected scopes", async () => {
		const { options } = harness({
			personal: [fact("p1", "the user's dog is named Fred")],
			"a/b": [fact("q1", "the repo uses vitest")],
		})
		const result = (await handleMemorySearch(options, { query: "dog", scope: "all" })) as {
			query: string
			results: Array<{ memory: string; score: number; scope: string }>
		}
		expect(result.query).toBe("dog")
		expect(result.results).toHaveLength(1)
		expect(result.results[0]).toMatchObject({ memory: "the user's dog is named Fred", scope: "personal" })
		expect(typeof result.results[0]?.score).toBe("number")
	})

	it("rejects a missing or empty query", async () => {
		const { options } = harness({})
		const missing = await thrownRequestErrorAsync(() => handleMemorySearch(options, { scope: "all" }))
		expect(missing.code).toBe(-32602)
		expect(missing.message).toContain("query")

		const blank = await thrownRequestErrorAsync(() => handleMemorySearch(options, { query: "   " }))
		expect(blank.code).toBe(-32602)
	})

	it("gateway failures surface as internalError, not invalidParams", async () => {
		const { options } = harness({ personal: [fact("p1", "a fact")] })
		const err = await thrownRequestErrorAsync(() =>
			handleMemorySearch(
				{ deps: { ...options.deps, createBackend: () => Promise.reject(new Error("gateway down")) } },
				{ query: "dog", scope: "all" },
			),
		)
		expect(err.code).toBe(-32603)
		expect(err.message).toContain("memory search failed")
		expect(err.message).toContain("gateway down")
	})
})

// --- memory_delete -----------------------------------------------------------------

describe("handleMemoryDelete", () => {
	it("deletes ids across stores and reports unknown ids", async () => {
		const { options, backends } = harness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		const result = (await handleMemoryDelete(options, { ids: ["p1", "q1", "missing"] })) as {
			deleted: Array<{ id: string; scope: string }>
			notFound: string[]
		}
		expect(result.deleted).toEqual([
			{ id: "p1", scope: "personal" },
			{ id: "q1", scope: "a/b" },
		])
		expect(result.notFound).toEqual(["missing"])
		const personalBackend = [...backends.entries()].find(([path]) => path.includes("personal"))?.[1]
		expect(personalBackend?.deleted).toEqual(["p1"])
	})

	it("rejects a missing, empty, or mistyped ids array", async () => {
		const { options } = harness({})
		for (const ids of [undefined, [], "p1", [1, 2]]) {
			const err = await thrownRequestErrorAsync(() => handleMemoryDelete(options, { ids }))
			expect(err.code).toBe(-32602)
			expect(err.message).toContain("ids")
		}
	})
})

// --- memory_reset --------------------------------------------------------------------

describe("handleMemoryReset", () => {
	it("requires an explicit confirm", async () => {
		const { options } = harness({ personal: [fact("p1", "a fact")] })
		for (const confirm of [undefined, false, "yes"]) {
			const err = await thrownRequestErrorAsync(() => handleMemoryReset(options, { scope: "personal", confirm }))
			expect(err.code).toBe(-32602)
			expect(err.message).toContain("confirm")
		}
	})

	it("rejects invalid scopes and project pairings", async () => {
		const { options } = harness({})
		const local = await thrownRequestErrorAsync(() => handleMemoryReset(options, { scope: "local", confirm: true }))
		expect(local.code).toBe(-32602)
		expect(local.message).toContain("scope must be one of")

		const missing = await thrownRequestErrorAsync(() => handleMemoryReset(options, { confirm: true }))
		expect(missing.code).toBe(-32602)

		const orphan = await thrownRequestErrorAsync(() =>
			handleMemoryReset(options, { scope: "personal", project: "a/b", confirm: true }),
		)
		expect(orphan.code).toBe(-32602)
		expect(orphan.message).toContain('pairs with scope "project"')

		const noProject = await thrownRequestErrorAsync(() =>
			handleMemoryReset(options, { scope: "project", confirm: true }),
		)
		expect(noProject.code).toBe(-32602)
		expect(noProject.message).toContain("project")
	})

	it("resets a personal store through the shared reset path", async () => {
		const { options, backends } = harness({
			personal: [fact("p1", "personal fact")],
			"a/b": [fact("q1", "project fact")],
		})
		const result = (await handleMemoryReset(options, { scope: "personal", confirm: true })) as {
			ok: boolean
			scope: string
			facts: number
		}
		expect(result).toEqual({ ok: true, scope: "personal", facts: 1 })
		const personalBackend = [...backends.entries()].find(([path]) => path.includes("personal"))?.[1]
		const projectBackend = [...backends.entries()].find(([path]) => path.includes("projects"))?.[1]
		expect(personalBackend?.isDeletedAll()).toBe(true)
		expect(projectBackend?.isDeletedAll()).toBe(false)
	})

	it("a missing project store is a client-facing error, not an internal one", async () => {
		const { options } = harness({ personal: [fact("p1", "a fact")] })
		const err = await thrownRequestErrorAsync(() =>
			handleMemoryReset(options, { scope: "project", project: "no/such", confirm: true }),
		)
		expect(err.code).toBe(-32602)
		expect(err.message).toContain("No memory store for no/such")
	})

	it("rejects the cwd param — the wipe target is fully determined by scope and project", async () => {
		const { options } = harness({ personal: [fact("p1", "a fact")] })
		const err = await thrownRequestErrorAsync(() =>
			handleMemoryReset(options, { scope: "personal", cwd: "/tmp", confirm: true }),
		)
		expect(err.code).toBe(-32602)
		expect(err.message).toContain("cwd is not accepted")
	})

	it("environmental failures surface as internalError, not invalidParams", async () => {
		const { options } = harness({ personal: [fact("p1", "a fact")] })
		const err = await thrownRequestErrorAsync(() =>
			handleMemoryReset(
				{ deps: { ...options.deps, acquireLock: () => Promise.reject(new Error("lock busy")) } },
				{ scope: "personal", confirm: true },
			),
		)
		expect(err.code).toBe(-32603)
		expect(err.message).toContain("lock busy")
	})
})

// --- agent dispatch (session identity seam) --------------------------------------
// Drives the real KimchiAcpAgent.extMethod switch: the session-scoped ops
// must resolve the live session and key the shared toggle on the SAME
// sessionManager instance the memory extension's ctx exposes in production.

describe("KimchiAcpAgent extMethod memory", () => {
	const realHome = process.env.HOME
	let home: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kimchi-acp-memory-agent-home-"))
		roots.push(home)
		process.env.HOME = home
	})
	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME
		else process.env.HOME = realHome
	})

	function makeAgent(session: BaseFakeAgentSession) {
		return new KimchiAcpAgent(makeAcpConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: makeAcpSessionFactory(session),
		})
	}

	it("set_memory_enabled flips the live session's toggle", async () => {
		setFeatureEnabled(true)
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.set_memory_enabled, {
			sessionId: "sess-1",
			enabled: false,
		})
		expect(result).toEqual({ sessionId: "sess-1", enabled: false })
		// The write landed on the session's OWN manager — the object the
		// memory extension's ctx.sessionManager resolves to in production.
		expect(getSessionMemoryOverride(session.sessionManager)).toBe(false)
	})

	it("memory_status reports the session state and the store overview", async () => {
		setFeatureEnabled(true)
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const result = (await agent.extMethod(AVAILABLE_EXT_METHODS.memory_status, {
			sessionId: "sess-1",
		})) as {
			featureEnabled: boolean
			sessionOverride: boolean | null
			sessionActive: boolean
			stores: unknown[]
		}
		expect(result.featureEnabled).toBe(true)
		expect(result.sessionOverride).toBeNull()
		expect(result.sessionActive).toBe(true)
		expect(result.stores).toEqual([]) // isolated HOME — no stores yet
	})

	it("set_memory_enabled on an unknown session is invalidParams", async () => {
		setFeatureEnabled(true)
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_memory_enabled, {
				sessionId: "nope",
				enabled: true,
			}),
		).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("unknown sessionId nope") })
	})

	it("memory_delete and memory_search dispatch through the agent", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// The destructive store op round-trips through the dispatch; with the
		// isolated HOME's empty stores every id lands in notFound.
		const deleted = await agent.extMethod(AVAILABLE_EXT_METHODS.memory_delete, { ids: ["no-such-id"] })
		expect(deleted).toEqual({ deleted: [], notFound: ["no-such-id"] })

		// The search dispatch proves its wiring; with no stores it returns
		// empty results without touching the embedding gateway.
		const search = (await agent.extMethod(AVAILABLE_EXT_METHODS.memory_search, { query: "anything" })) as {
			results: unknown[]
		}
		expect(search.results).toEqual([])
	})
})
