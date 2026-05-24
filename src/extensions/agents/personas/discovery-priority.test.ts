import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Point getAgentDir() to a temp dir so global agents don't pollute project-only tests
const FAKE_AGENT_DIR = join(tmpdir(), `kimchi-global-${Date.now()}`)

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, getAgentDir: () => FAKE_AGENT_DIR }
})

import { loadCustomAgents } from "./custom-agents.js"

function writeAgentMd(dir: string, name: string, description: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\nSystem prompt for ${name}.`)
}

describe("discovery-priority: project agents override global", () => {
	beforeEach(() => {
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
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
