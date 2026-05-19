import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../package-resources.js", () => ({
	getInstalledPackageResourceDirs: vi.fn(() => []),
}))

import { getInstalledPackageResourceDirs } from "../package-resources.js"
import { loadCustomAgents } from "./custom-agents.js"

const FAKE_AGENT_DIR = join(tmpdir(), `kimchi-global-custom-agents-${Date.now()}`)

function writeAgentMd(dir: string, name: string, frontmatter: string, body = "System prompt."): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`)
}

describe("AgentConfig.tokenBudget parsing", () => {
	let projectDir: string
	let projectAgentsDir: string

	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = FAKE_AGENT_DIR
		mkdirSync(FAKE_AGENT_DIR, { recursive: true })
		projectDir = join(tmpdir(), `kimchi-project-token-budget-${Date.now()}`)
		projectAgentsDir = join(projectDir, ".kimchi", "agents")
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env var must be deleted, not set to "undefined"
		delete process.env.PI_CODING_AGENT_DIR
	})

	it("parses token_budget: 50000 into tokenBudget === 50000", () => {
		writeAgentMd(projectAgentsDir, "budgeted-agent", "description: budgeted\ntoken_budget: 50000")

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("budgeted-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBe(50000)
	})

	it("leaves tokenBudget undefined when token_budget is not present", () => {
		writeAgentMd(projectAgentsDir, "no-budget-agent", "description: no budget here")

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("no-budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBeUndefined()
	})

	it("leaves tokenBudget undefined when token_budget is a non-numeric string", () => {
		writeAgentMd(projectAgentsDir, "bad-budget-agent", "description: bad budget\ntoken_budget: abc")

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("bad-budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBeUndefined()
	})

	it("leaves tokenBudget undefined when token_budget is negative", () => {
		writeAgentMd(projectAgentsDir, "negative-budget-agent", "description: negative budget\ntoken_budget: -5")

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("negative-budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBeUndefined()
	})

	it("leaves tokenBudget undefined when token_budget is 0", () => {
		writeAgentMd(projectAgentsDir, "zero-budget-agent", "description: zero budget\ntoken_budget: 0")

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("zero-budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBeUndefined()
	})
})

describe("custom agents — user override hierarchy preserves new fields", () => {
	let packageAgentsDir: string
	let globalAgentsDir: string
	let projectDir: string
	let projectAgentsDir: string
	let tmpRoot: string

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `kimchi-hierarchy-${Date.now()}`)

		packageAgentsDir = join(tmpRoot, "package", "agents")
		mkdirSync(packageAgentsDir, { recursive: true })

		globalAgentsDir = join(tmpRoot, "global", "agents")
		mkdirSync(globalAgentsDir, { recursive: true })
		process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "global")

		projectDir = join(tmpRoot, "project")
		projectAgentsDir = join(projectDir, ".kimchi", "agents")
		mkdirSync(projectAgentsDir, { recursive: true })

		vi.mocked(getInstalledPackageResourceDirs).mockReturnValue([packageAgentsDir])
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env var must be deleted, not set to "undefined"
		delete process.env.PI_CODING_AGENT_DIR
		rmSync(tmpRoot, { recursive: true, force: true })
		vi.mocked(getInstalledPackageResourceDirs).mockReturnValue([])
	})

	it("project token_budget wins over global and package (project=300 > global=200 > package=100)", () => {
		writeFileSync(
			join(packageAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 100\n---\nPackage prompt.",
		)
		writeFileSync(
			join(globalAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 200\n---\nGlobal prompt.",
		)
		writeFileSync(
			join(projectAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 300\n---\nProject prompt.",
		)

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBe(300)
		expect(agent?.source).toBe("project")
	})

	it("global token_budget wins over package when no project file exists (global=200 > package=100)", () => {
		writeFileSync(
			join(packageAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 100\n---\nPackage prompt.",
		)
		writeFileSync(
			join(globalAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 200\n---\nGlobal prompt.",
		)

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBe(200)
		expect(agent?.source).toBe("global")
	})

	it("package token_budget is used when no global or project file exists (package=100)", () => {
		writeFileSync(
			join(packageAgentsDir, "budget-agent.md"),
			"---\ndescription: budget agent\ntoken_budget: 100\n---\nPackage prompt.",
		)

		const agents = loadCustomAgents(projectDir)
		const agent = agents.get("budget-agent")

		expect(agent).toBeDefined()
		expect(agent?.tokenBudget).toBe(100)
		expect(agent?.source).toBe("package")
	})
})
