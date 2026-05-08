import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveMemoryDir } from "./memory.js"

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
		// biome-ignore lint/performance/noDelete: env var must be deleted, not set to "undefined"
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
