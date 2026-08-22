import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type AgentMemoryProvider,
	clearMemoryProviders,
	getMemoryProviders,
	registerMemoryProvider,
	resetProviderLoadState,
	resolveMemoryBlock,
	resolveMemoryDir,
	resolveMemoryProvidersConfig,
} from "./memory.js"

const FAKE_AGENT_DIR = join(homedir(), ".config", "kimchi", "harness")

// Pi's getAgentDir() resolves <APP_NAME>_CODING_AGENT_DIR. APP_NAME comes from the
// piConfig.name in the consumer's package.json. In a vitest run, pi-coding-agent's own
// package.json (no piConfig) is what gets loaded, so APP_NAME defaults to "pi" and the
// env var is PI_CODING_AGENT_DIR. In production (the kimchi binary), kimchi's
// package.json sets piConfig.name=kimchi, so the var becomes KIMCHI_CODING_AGENT_DIR.
describe("resolveMemoryDir", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = FAKE_AGENT_DIR
	})

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR
	})

	it("user scope resolves under PI_CODING_AGENT_DIR/agent-memory/", () => {
		const dir = resolveMemoryDir("my-agent", "user", "/any/cwd")
		const expected = join(FAKE_AGENT_DIR, "agent-memory", "my-agent")
		expect(dir).toBe(expected)
	})

	it("project scope resolves under <cwd>/.kimchi/agent-memory/", () => {
		const cwd = "/some/project"
		const dir = resolveMemoryDir("my-agent", "project", cwd)
		expect(dir).toBe(join(cwd, ".kimchi", "agent-memory", "my-agent"))
	})

	it("local scope resolves under <cwd>/.kimchi/agent-memory-local/", () => {
		const cwd = "/some/project"
		const dir = resolveMemoryDir("my-agent", "local", cwd)
		expect(dir).toBe(join(cwd, ".kimchi", "agent-memory-local", "my-agent"))
	})

	it("throws for unsafe agent names with path traversal", () => {
		expect(() => resolveMemoryDir("../evil", "project", "/cwd")).toThrow()
		expect(() => resolveMemoryDir("evil/path", "project", "/cwd")).toThrow()
	})

	it("path does not contain '.pi' segments for any scope", () => {
		const userDir = resolveMemoryDir("agent", "user", "/cwd")
		const projectDir = resolveMemoryDir("agent", "project", "/cwd")
		const localDir = resolveMemoryDir("agent", "local", "/cwd")
		expect(userDir).not.toContain("/.pi/")
		expect(projectDir).not.toContain("/.pi/")
		expect(localDir).not.toContain("/.pi/")
	})
})

describe("memory provider registry", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "kimchi-agent-dir-"))
	})

	afterEach(() => {
		clearMemoryProviders()
		resetProviderLoadState()
		delete process.env.PI_CODING_AGENT_DIR
		vi.unstubAllGlobals()
	})

	it("starts empty — the harness has no provider-specific code", () => {
		expect(getMemoryProviders()).toEqual([])
	})

	describe("config-driven provider loading", () => {
		function writeManifest(entries: unknown[]): void {
			const configPath = resolveMemoryProvidersConfig()
			mkdirSync(join(configPath, ".."), { recursive: true })
			writeFileSync(configPath, JSON.stringify(entries))
		}

		function writeFixtureModule(body: string): string {
			const file = join(process.env.PI_CODING_AGENT_DIR as string, "fixture-provider.mjs")
			writeFileSync(file, body)
			return file
		}

		it("loads a provider listed in memory-providers.json", async () => {
			const modulePath = writeFixtureModule(
				`export default { name: "fixture", buildBlock: async (agent, cwd) => "# Fixture " + agent }`,
			)
			writeManifest([{ name: "fixture", module: modulePath }])
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(block).toBe("# Fixture my-agent")
			expect(getMemoryProviders().map((p) => p.name)).toEqual(["fixture"])
		})

		it("is a no-op when the config file is missing", async () => {
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
		})

		it("skips invalid entries and unloadable modules (fail-open)", async () => {
			writeManifest([{ name: "no-module" }, { module: "/nonexistent/path/provider.mjs" }, { module: 42 }])
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
		})

		it("rejects relative module paths before any import", async () => {
			const modulePath = writeFixtureModule(`export default { name: "relative", buildBlock: async () => "# Relative" }`)
			// Manifest entry uses a relative reference to the same file — must be skipped.
			writeManifest([{ name: "relative", module: "./fixture-provider.mjs" }])
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
			expect(modulePath).toBeTruthy()
		})

		it("rejects symlinked module paths", async () => {
			const symlinkSyncMod = await import("node:fs")
			const modulePath = writeFixtureModule(`export default { name: "linked", buildBlock: async () => "# Linked" }`)
			const linkPath = join(process.env.PI_CODING_AGENT_DIR as string, "linked-provider.mjs")
			symlinkSyncMod.symlinkSync(modulePath, linkPath)
			writeManifest([{ name: "linked", module: linkPath }])
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
		})

		it("skips modules whose default export does not match the contract", async () => {
			const badModule = writeFixtureModule(`export default { name: 42 }`)
			writeManifest([{ module: badModule }])
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
		})

		it("ignores malformed JSON in the config file", async () => {
			const configPath = resolveMemoryProvidersConfig()
			mkdirSync(join(configPath, ".."), { recursive: true })
			writeFileSync(configPath, "{ not json")
			const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
			expect(getMemoryProviders()).toEqual([])
			expect(block).toContain("# Agent Memory")
		})
	})

	it("first non-null provider block wins", async () => {
		clearMemoryProviders()
		const nullProvider: AgentMemoryProvider = {
			name: "nothing",
			buildBlock: vi.fn().mockResolvedValue(null),
		}
		const blockProvider: AgentMemoryProvider = {
			name: "custom-db",
			buildBlock: vi.fn().mockResolvedValue("# Custom Memory\nfrom custom db"),
		}
		const afterProvider: AgentMemoryProvider = {
			name: "after",
			buildBlock: vi.fn().mockResolvedValue("should not be used"),
		}
		registerMemoryProvider(nullProvider)
		registerMemoryProvider(blockProvider)
		registerMemoryProvider(afterProvider)

		const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
		expect(block).toBe("# Custom Memory\nfrom custom db")
		expect(blockProvider.buildBlock).toHaveBeenCalledWith("my-agent", "/cwd", {
			scope: "user",
			hasWriteTools: true,
		})
		expect(afterProvider.buildBlock).not.toHaveBeenCalled()
	})

	it("treats a provider returning undefined as not applicable", async () => {
		clearMemoryProviders()
		registerMemoryProvider({
			name: "undefined-provider",
			buildBlock: vi.fn().mockResolvedValue(undefined),
		})
		registerMemoryProvider({ name: "ok", buildBlock: vi.fn().mockResolvedValue("# OK") })
		const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
		expect(block).toBe("# OK")
	})

	it("passes read-only mode through the provider context", async () => {
		clearMemoryProviders()
		const spy = vi.fn().mockResolvedValue(null)
		registerMemoryProvider({ name: "spy", buildBlock: spy })
		await resolveMemoryBlock("my-agent", "project", "/cwd", false)
		expect(spy).toHaveBeenCalledWith("my-agent", "/cwd", {
			scope: "project",
			hasWriteTools: false,
		})
	})

	it("falls back to file memory when all providers return null", async () => {
		clearMemoryProviders()
		registerMemoryProvider({ name: "null", buildBlock: vi.fn().mockResolvedValue(null) })
		const block = await resolveMemoryBlock("fb-agent", "user", "/cwd", true)
		expect(block).toContain("# Agent Memory")
		expect(block).toContain("Memory Instructions")
	})

	it("contains provider exceptions (fail-open) and tries the next provider", async () => {
		clearMemoryProviders()
		registerMemoryProvider({
			name: "broken",
			buildBlock: vi.fn().mockRejectedValue(new Error("db exploded")),
		})
		registerMemoryProvider({ name: "ok", buildBlock: vi.fn().mockResolvedValue("# OK") })
		const block = await resolveMemoryBlock("my-agent", "user", "/cwd", true)
		expect(block).toBe("# OK")
	})

	it("broken single provider falls through to file memory", async () => {
		clearMemoryProviders()
		registerMemoryProvider({
			name: "broken",
			buildBlock: vi.fn().mockRejectedValue(new Error("down")),
		})
		const block = await resolveMemoryBlock("fb2-agent", "user", "/cwd", false)
		expect(block).toContain("# Agent Memory (read-only)")
	})
})
