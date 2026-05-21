import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSystemPromptBlocks } from "./system-prompt-blocks.js"
import { type EnvironmentInfo, buildSystemPrompt } from "./system-prompt.js"

type ShutdownHandler = () => void

const testEnv: EnvironmentInfo = {
	os: "Linux",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

const testTools = [{ name: "read", description: "Read file contents" }]

const activePis: Array<{ fireShutdown: () => void }> = []

function makePi(): ExtensionAPI & { fireShutdown: () => void } {
	const shutdownHandlers: ShutdownHandler[] = []
	const pi = {
		on(event: string, handler: ShutdownHandler) {
			if (event === "session_shutdown") shutdownHandlers.push(handler)
		},
		fireShutdown() {
			for (const handler of shutdownHandlers) handler()
		},
	}
	activePis.push(pi)
	return pi as unknown as ExtensionAPI & { fireShutdown: () => void }
}

function prompt(pi?: ExtensionAPI): string {
	return buildSystemPrompt({
		pi,
		tools: testTools,
		env: testEnv,
		contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rule." }],
		mode: "orchestrator",
	})
}

function idlePrompt(): string {
	return prompt()
}

afterEach(() => {
	for (const pi of activePis.splice(0)) pi.fireShutdown()
	vi.restoreAllMocks()
})

describe("system prompt blocks", () => {
	it("produces byte-identical prompts when register call order changes", () => {
		const piA = makePi()
		const aFirst = createSystemPromptBlocks(piA, "a")
		const bFirst = createSystemPromptBlocks(piA, "b")
		bFirst.register({ id: "two", render: () => "## B Two" })
		aFirst.register({ id: "one", render: () => "## A One" })
		const first = prompt(piA)
		piA.fireShutdown()

		const piB = makePi()
		const bSecond = createSystemPromptBlocks(piB, "b")
		const aSecond = createSystemPromptBlocks(piB, "a")
		aSecond.register({ id: "one", render: () => "## A One" })
		bSecond.register({ id: "two", render: () => "## B Two" })
		const second = prompt(piB)

		expect(second).toBe(first)
	})

	it("renders active blocks in owner/id order regardless of registration order", () => {
		const pi = makePi()
		const z = createSystemPromptBlocks(pi, "z-owner")
		const a = createSystemPromptBlocks(pi, "a-owner")

		z.register({ id: "b", render: () => "## ZB" })
		a.register({ id: "b", render: () => "## AB" })
		a.register({ id: "a", render: () => "## AA" })
		z.register({ id: "a", render: () => "## ZA" })

		const result = prompt(pi)
		expect(result.indexOf("## AA")).toBeLessThan(result.indexOf("## AB"))
		expect(result.indexOf("## AB")).toBeLessThan(result.indexOf("## ZA"))
		expect(result.indexOf("## ZA")).toBeLessThan(result.indexOf("## ZB"))
	})

	it("treats render(undefined) as inactive and does not apply suppression", () => {
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({
			id: "inactive",
			render: () => undefined,
			suppress: () => new Set(["orchestration"]),
		})

		const result = prompt(pi)
		expect(result).not.toContain("inactive")
		expect(result).toContain("Orchestrate the work")
	})

	it("skips whitespace-only rendered content", () => {
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({ id: "empty", render: () => " \n\t " })

		expect(prompt(pi)).toBe(idlePrompt())
	})

	it("skips a block whose render throws without failing the prompt build", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({
			id: "bad-render",
			render: () => {
				throw new Error("boom")
			},
		})
		blocks.register({ id: "good", render: () => "## Good Block" })

		const result = prompt(pi)
		expect(result).toContain("## Good Block")
		expect(result).not.toContain("bad-render")
		expect(warn).toHaveBeenCalledWith("system-prompt-blocks: test/bad-render render failed: boom")
	})

	it("keeps block content when suppress throws and treats suppression as empty", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({
			id: "bad-suppress",
			render: () => "## Bad Suppress Block",
			suppress: () => {
				throw new Error("nope")
			},
		})

		const result = prompt(pi)
		expect(result).toContain("## Bad Suppress Block")
		expect(result).toContain("Orchestrate the work")
		expect(warn).toHaveBeenCalledWith("system-prompt-blocks: test/bad-suppress suppress failed: nope")
	})

	it("unions disjoint suppression from active blocks", () => {
		const pi = makePi()
		const a = createSystemPromptBlocks(pi, "a")
		const b = createSystemPromptBlocks(pi, "b")
		a.register({
			id: "hide-core",
			render: () => "## A Block",
			suppress: () => new Set(["orchestration", "project-context"]),
		})
		b.register({
			id: "hide-skills",
			render: () => "## B Block",
			suppress: () => new Set(["skills"]),
		})

		const result = buildSystemPrompt({
			pi,
			tools: testTools,
			env: testEnv,
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rule." }],
			skills: [
				{
					name: "deploy",
					description: "Deploy app",
					filePath: "/skills/deploy/SKILL.md",
					baseDir: "/skills/deploy",
					sourceInfo: { path: "/skills/deploy/SKILL.md", source: "local", scope: "project", origin: "top-level" },
					disableModelInvocation: false,
				},
			],
			mode: "orchestrator",
		})

		expect(result).toContain("## A Block")
		expect(result).toContain("## B Block")
		expect(result).not.toContain("Orchestrate the work")
		expect(result).not.toContain("Project rule.")
		expect(result).not.toContain("available_skills")
	})

	it("suppression union is idempotent when multiple active blocks suppress the same section", () => {
		const pi = makePi()
		const a = createSystemPromptBlocks(pi, "a")
		const b = createSystemPromptBlocks(pi, "b")
		a.register({
			id: "hide-project-a",
			render: () => "## A Block",
			suppress: () => new Set(["project-context"]),
		})
		b.register({
			id: "hide-project-b",
			render: () => "## B Block",
			suppress: () => new Set(["project-context"]),
		})

		const result = prompt(pi)
		expect(result).toContain("## A Block")
		expect(result).toContain("## B Block")
		expect(result).not.toContain("Project rule.")
		expect(result).toContain("Orchestrate the work")
		expect(result).toContain("## Available Tools")
	})

	it("places rendered blocks between project context and tools", () => {
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({ id: "frame", render: () => "## Frame\n\nUse this frame." })

		const result = prompt(pi)
		const project = result.indexOf("## Project Guidelines")
		const frame = result.indexOf("## Frame")
		const tools = result.indexOf("## Available Tools")

		expect(project).toBeGreaterThan(-1)
		expect(frame).toBeGreaterThan(-1)
		expect(tools).toBeGreaterThan(-1)
		expect(project).toBeLessThan(frame)
		expect(frame).toBeLessThan(tools)
	})

	it("joins rendered blocks with blank lines and prepends a blank line before the first block", () => {
		const pi = makePi()
		const blocks = createSystemPromptBlocks(pi, "test")
		blocks.register({ id: "a", render: () => "## First\n\nAlpha" })
		blocks.register({ id: "b", render: () => "## Second\n\nBeta" })

		const result = prompt(pi)
		expect(result).toContain("Project rule.\n\n## First")
		expect(result).toContain("Alpha\n\n## Second")
		expect(result).toContain("Beta\n\n## Available Tools")
	})

	it("matches the idle prompt when no blocks are active", () => {
		const before = idlePrompt()
		const pi = makePi()
		createSystemPromptBlocks(pi, "test").register({ id: "inactive", render: () => undefined })

		expect(prompt(pi)).toBe(before)
	})

	it("cleans up all blocks for a pi on session_shutdown", () => {
		const pi = makePi()
		createSystemPromptBlocks(pi, "test").register({ id: "one", render: () => "## One" })
		expect(prompt(pi)).toContain("## One")

		pi.fireShutdown()

		expect(prompt(pi)).not.toContain("## One")
		createSystemPromptBlocks(pi, "test").register({ id: "two", render: () => "## Two" })
		expect(prompt(pi)).toContain("## Two")
	})

	it("renders only blocks registered to the pi building the prompt", () => {
		const piA = makePi()
		const piB = makePi()
		createSystemPromptBlocks(piA, "a").register({ id: "one", render: () => "## Pi A Block" })
		createSystemPromptBlocks(piB, "b").register({ id: "one", render: () => "## Pi B Block" })

		const resultA = prompt(piA)
		expect(resultA).toContain("## Pi A Block")
		expect(resultA).not.toContain("## Pi B Block")

		const resultB = prompt(piB)
		expect(resultB).not.toContain("## Pi A Block")
		expect(resultB).toContain("## Pi B Block")
	})

	it("keeps registrations isolated across pi instances after shutdown", () => {
		const piA = makePi()
		const piB = makePi()
		createSystemPromptBlocks(piA, "a").register({ id: "one", render: () => "## Pi A Block" })
		createSystemPromptBlocks(piB, "b").register({ id: "one", render: () => "## Pi B Block" })

		piA.fireShutdown()

		const result = prompt(piB)
		expect(result).not.toContain("## Pi A Block")
		expect(result).toContain("## Pi B Block")
	})
})
