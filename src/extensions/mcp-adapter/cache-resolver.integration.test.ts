/**
 * Cache and resolver integration tests.
 *
 * Exercises the on-disk metadata cache + `resolveDirectTools` pipeline that the
 * MCP direct-tools registration depends on. Each test gets a fresh temp
 * `KIMCHI_CODING_AGENT_DIR` and re-imports the cache module so the memoized
 * cache path (`metadata-cache.ts:13`) picks up the per-test env override.
 *
 * Scope intentionally stops at the cache + resolver layer:
 *   - End-to-end `initializeMcp` bootstrap requires either a real MCP server
 *     subprocess or a `McpServerManager` injection refactor; both are out of
 *     scope for this PR.
 *   - `registerAndActivate(..., { markDynamic: false })` needs a stub
 *     `ExtensionAPI`; that helper warrants its own file and follow-up.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { McpConfig, ServerEntry } from "./types.js"

// Module surface — typed via import type so the dynamic imports below stay
// strongly typed without locking in a single module instance.
type CacheModule = typeof import("./metadata-cache.js")
type DirectToolsModule = typeof import("./direct-tools.js")

// ─── Test harness ─────────────────────────────────────────────────────────────

interface Harness {
	cacheModule: CacheModule
	directToolsModule: DirectToolsModule
	cachePath: string
}

let tempHome: string | undefined
let originalEnv: string | undefined

/**
 * Set up a fresh temp agent directory and re-import the cache + resolver
 * modules so their module-level memoization picks up the new
 * `KIMCHI_CODING_AGENT_DIR`.
 */
async function buildHarness(): Promise<Harness> {
	tempHome = mkdtempSync(join(tmpdir(), "mcp-cache-test-"))
	process.env.KIMCHI_CODING_AGENT_DIR = tempHome

	vi.resetModules()
	const cacheModule = await import("./metadata-cache.js")
	const directToolsModule = await import("./direct-tools.js")
	return {
		cacheModule,
		directToolsModule,
		cachePath: join(tempHome, "mcp-cache.json"),
	}
}

beforeEach(() => {
	originalEnv = process.env.KIMCHI_CODING_AGENT_DIR
})

afterEach(() => {
	if (originalEnv === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = originalEnv
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true })
		tempHome = undefined
	}
})

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const JETBRAINS_DEF: ServerEntry = {
	url: "http://127.0.0.1:64342/sse",
	headers: {},
	directTools: true,
}

const SUPABASE_DEF: ServerEntry = {
	command: "npx",
	args: ["-y", "supabase-mcp"],
	directTools: true,
}

function cacheEntry(opts: {
	configHash: string
	tools?: Array<{ name: string; description?: string }>
}) {
	return {
		configHash: opts.configHash,
		tools: opts.tools ?? [],
		resources: [],
		cachedAt: Date.now(),
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("purgeStaleEntries", () => {
	it("drops mismatched-hash entries for configured servers, preserves orphans", async () => {
		const { cacheModule } = await buildHarness()
		const { purgeStaleEntries, computeServerHash } = cacheModule

		const orphanDef: ServerEntry = {
			command: "stale-orphan",
			args: ["from", "another", "project"],
		}

		const cache = {
			version: 1,
			servers: {
				jetbrains: cacheEntry({ configHash: "stale-deadbeef" }),
				supabase: cacheEntry({ configHash: computeServerHash(SUPABASE_DEF) }),
				// 'orphan' is in the on-disk cache but NOT in the current project's
				// mcp.json — it belongs to another project that shares the same
				// cache file. Must survive the purge.
				orphan: cacheEntry({ configHash: computeServerHash(orphanDef) }),
			},
		}

		const { cleaned, removed } = purgeStaleEntries(cache, {
			jetbrains: JETBRAINS_DEF,
			supabase: SUPABASE_DEF,
		})

		expect(removed).toEqual(["jetbrains"])
		expect(Object.keys(cleaned.servers).sort()).toEqual(["orphan", "supabase"])
	})

	it("returns an empty cleaned cache for null or empty input", async () => {
		const { cacheModule } = await buildHarness()
		const { purgeStaleEntries } = cacheModule

		const fromNull = purgeStaleEntries(null, { jetbrains: JETBRAINS_DEF })
		expect(fromNull.removed).toEqual([])
		expect(fromNull.cleaned).toEqual({ version: 1, servers: {} })

		const fromEmpty = purgeStaleEntries({ version: 1, servers: {} }, { jetbrains: JETBRAINS_DEF })
		expect(fromEmpty.removed).toEqual([])
		expect(fromEmpty.cleaned).toEqual({ version: 1, servers: {} })
	})
})

describe("overwriteMetadataCache vs saveMetadataCache", () => {
	it("overwriteMetadataCache replaces the on-disk content (no merge)", async () => {
		const { cacheModule } = await buildHarness()
		const { saveMetadataCache, overwriteMetadataCache, loadMetadataCache } = cacheModule

		saveMetadataCache({
			version: 1,
			servers: { a: cacheEntry({ configHash: "hash-a" }) },
		})
		overwriteMetadataCache({
			version: 1,
			servers: { b: cacheEntry({ configHash: "hash-b" }) },
		})

		const cache = loadMetadataCache()
		expect(Object.keys(cache?.servers ?? {})).toEqual(["b"])
	})

	it("saveMetadataCache still merges (regression guard for existing callers)", async () => {
		const { cacheModule } = await buildHarness()
		const { saveMetadataCache, overwriteMetadataCache, loadMetadataCache } = cacheModule

		overwriteMetadataCache({
			version: 1,
			servers: { a: cacheEntry({ configHash: "hash-a" }) },
		})
		saveMetadataCache({
			version: 1,
			servers: { b: cacheEntry({ configHash: "hash-b" }) },
		})

		const cache = loadMetadataCache()
		expect(Object.keys(cache?.servers ?? {}).sort()).toEqual(["a", "b"])
	})
})

describe("end-to-end stale → purge → resolve", () => {
	it("rejects stale cache, regenerates, then resolves direct-tool specs", async () => {
		const { cacheModule, directToolsModule } = await buildHarness()
		const { saveMetadataCache, overwriteMetadataCache, loadMetadataCache, purgeStaleEntries, computeServerHash } =
			cacheModule
		const { resolveDirectTools } = directToolsModule

		const config: McpConfig = { mcpServers: { jetbrains: JETBRAINS_DEF } }

		// (a) Seed a stale entry for jetbrains.
		saveMetadataCache({
			version: 1,
			servers: {
				jetbrains: cacheEntry({
					configHash: "stale-from-an-older-config",
					tools: [{ name: "get_all_open_file_paths" }, { name: "build_project" }],
				}),
			},
		})

		// (b) Resolver rejects the stale entry — this is the user-visible bug.
		expect(resolveDirectTools(config, loadMetadataCache(), "server")).toEqual([])

		// (c) Purge + overwrite removes it from disk.
		const { cleaned, removed } = purgeStaleEntries(loadMetadataCache(), config.mcpServers)
		expect(removed).toEqual(["jetbrains"])
		overwriteMetadataCache(cleaned)
		expect(loadMetadataCache()?.servers?.jetbrains).toBeUndefined()

		// (d) Bootstrap-equivalent: write a fresh entry with the correct hash.
		saveMetadataCache({
			version: 1,
			servers: {
				jetbrains: cacheEntry({
					configHash: computeServerHash(JETBRAINS_DEF),
					tools: [
						{ name: "get_all_open_file_paths", description: "list open files" },
						{ name: "build_project", description: "build" },
					],
				}),
			},
		})

		// (e) Resolver now produces direct-tool specs with prefixed names — these
		// are exactly what `pi.registerTool` would receive at module load.
		const specs = resolveDirectTools(config, loadMetadataCache(), "server")
		const names = specs.map((s) => s.prefixedName).sort()
		expect(names).toEqual(["jetbrains_build_project", "jetbrains_get_all_open_file_paths"])
		for (const spec of specs) {
			expect(spec.serverName).toBe("jetbrains")
			expect(spec.originalName).toBe(spec.prefixedName.replace(/^jetbrains_/, ""))
		}
	})
})

describe("resolveDirectTools — interaction with config knobs", () => {
	it("honors excludeTools", async () => {
		const { cacheModule, directToolsModule } = await buildHarness()
		const { saveMetadataCache, computeServerHash, loadMetadataCache } = cacheModule
		const { resolveDirectTools } = directToolsModule

		const def: ServerEntry = { ...JETBRAINS_DEF, excludeTools: ["banned"] }
		saveMetadataCache({
			version: 1,
			servers: {
				jetbrains: cacheEntry({
					configHash: computeServerHash(def),
					tools: [{ name: "get_status" }, { name: "banned" }, { name: "list_open" }],
				}),
			},
		})

		const specs = resolveDirectTools({ mcpServers: { jetbrains: def } }, loadMetadataCache(), "server")
		const names = specs.map((s) => s.originalName).sort()
		expect(names).toEqual(["get_status", "list_open"])
	})

	it("ignores cache entries with directTools=false but purge keeps them (hash-keyed)", async () => {
		const { cacheModule, directToolsModule } = await buildHarness()
		const { saveMetadataCache, computeServerHash, loadMetadataCache, purgeStaleEntries } = cacheModule
		const { resolveDirectTools } = directToolsModule

		const def: ServerEntry = { ...JETBRAINS_DEF, directTools: false }
		saveMetadataCache({
			version: 1,
			servers: {
				jetbrains: cacheEntry({
					configHash: computeServerHash(def),
					tools: [{ name: "get_open_files" }],
				}),
			},
		})

		// Resolver short-circuits because directTools=false — even though the
		// hash is valid and tools are cached.
		expect(resolveDirectTools({ mcpServers: { jetbrains: def } }, loadMetadataCache(), "server")).toEqual([])

		// Purge keys off configHash, not directTools. The entry stays.
		const { cleaned, removed } = purgeStaleEntries(loadMetadataCache(), { jetbrains: def })
		expect(removed).toEqual([])
		expect(cleaned.servers.jetbrains).toBeDefined()
	})
})
