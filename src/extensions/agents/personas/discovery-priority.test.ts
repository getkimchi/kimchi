import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadCustomAgents } from "./custom-agents.js"

// Point getAgentDir() to a temp dir so global agents don't pollute project-only tests
const FAKE_AGENT_DIR = join(tmpdir(), `kimchi-global-${Date.now()}`)

function writeAgentMd(dir: string, name: string, description: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\nSystem prompt for ${name}.`)
}

describe("discovery-priority: project agents override global", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = FAKE_AGENT_DIR
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env var must be deleted, not set to "undefined"
		delete process.env.PI_CODING_AGENT_DIR
	})

	it("project .kimchi/agents/ overrides global agent with same name", () => {
		const cwd = join(tmpdir(), `kimchi-project-${Date.now()}`)

		// Write global agent
		const globalAgentsDir = join(FAKE_AGENT_DIR, "agents")
		writeAgentMd(globalAgentsDir, "my-agent", "global version")

		// Write project agent with same name but different description
		const projectAgentsDir = join(cwd, ".kimchi", "agents")
		writeAgentMd(projectAgentsDir, "my-agent", "project version")

		const agents = loadCustomAgents(cwd)
		expect(agents.has("my-agent")).toBe(true)
		expect(agents.get("my-agent")?.description).toBe("project version")
		expect(agents.get("my-agent")?.source).toBe("project")
	})

	it("global agent is returned when no project override exists", () => {
		const cwd = join(tmpdir(), `kimchi-global-only-${Date.now()}`)
		mkdirSync(cwd, { recursive: true })

		const globalAgentsDir = join(FAKE_AGENT_DIR, "agents")
		writeAgentMd(globalAgentsDir, "global-only-agent", "from global")

		const agents = loadCustomAgents(cwd)
		expect(agents.has("global-only-agent")).toBe(true)
		expect(agents.get("global-only-agent")?.source).toBe("global")
	})

	it("project agent dirs use .kimchi not .pi", () => {
		const cwd = join(tmpdir(), `kimchi-path-check-${Date.now()}`)
		const projectAgentsDir = join(cwd, ".kimchi", "agents")
		writeAgentMd(projectAgentsDir, "path-check-agent", "kimchi path agent")

		const agents = loadCustomAgents(cwd)
		const agent = agents.get("path-check-agent")
		expect(agent).toBeDefined()
		expect(agent?.source).toBe("project")
	})
})
